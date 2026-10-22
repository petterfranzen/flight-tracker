package com.flighttracker.service.confirmation;

import com.flighttracker.service.agent.PollBackoff;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;

/**
 * The one place a provider is called from. It gives every provider the same
 * protections, so a provider only maps a request to a response:
 *
 * <ul>
 *   <li>a result cache keyed by (provider, callsign, arrival airport, UTC date
 *       of the expected arrival), bounded, with a TTL by outcome: FOUND without
 *       a gate-in time {@value #TTL_FOUND_MINUTES_NO_IN} min (the gate may still
 *       come), FOUND with one 12 h, NOT_FOUND 15 min; a provider may lengthen the
 *       first and the last ({@link ArrivalConfirmationProvider#foundRecheck()},
 *       {@link ArrivalConfirmationProvider#notFoundRecheck()}) but not shorten them.
 *       THROTTLED and FAILED are never cached;</li>
 *   <li>a query the provider does not {@link ArrivalConfirmationProvider#accepts accept}
 *       is answered NOT_FOUND without a charge, pacing or a call;</li>
 *   <li>a refund for a call that never did the upstream's work: THROTTLED, or a
 *       result that reports a lower {@link LookupResult#costUnits()};</li>
 *   <li>a cache of whole arrivals boards for {@link AirportArrivalsProvider}s,
 *       keyed by (provider, airport, board date: the UTC date unless the provider
 *       overrides {@link AirportArrivalsProvider#boardDate}), bounded, fresh for
 *       {@code board-ttl-seconds}. A board is fetched only when {@link #board}
 *       is asked for one that is missing or stale; nothing polls in the
 *       background;</li>
 *   <li>a minimum interval between two real calls to the same provider;</li>
 *   <li>a daily and a monthly budget per provider in cost units
 *       ({@link ConfirmationBudgets}, kept in app_state across restarts), for
 *       free tiers with a quota;</li>
 *   <li>{@link PollBackoff} on THROTTLED and FAILED, honouring the retry-after
 *       up to {@code max-retry-after-minutes};</li>
 *   <li>a cached FOUND whose landing time is earlier than the query's expected
 *       arrival (minus {@code skew-tolerance-seconds}) is about an earlier leg
 *       of the same callsign and airport, so it counts as a miss (re-checked
 *       at most every {@value #TTL_FOUND_MINUTES_NO_IN} min).</li>
 * </ul>
 *
 * A call that is paced, over budget or cooling down is not made and is not a
 * failure: the caller gets {@link Kind#SKIPPED} and asks again next tick.
 * Thread-safe: the per-provider state is guarded by its own monitor, the same
 * way OpenSkyFlightsClient guards its backoff.
 */
@Component
public class ConfirmationGateway {

    private static final Logger log = LoggerFactory.getLogger(ConfirmationGateway.class);

    static final long TTL_FOUND_MINUTES_NO_IN = 5;
    static final Duration TTL_FOUND_NO_IN = Duration.ofMinutes(TTL_FOUND_MINUTES_NO_IN);
    static final Duration TTL_FOUND_IN = Duration.ofHours(12);
    static final Duration TTL_NOT_FOUND = Duration.ofMinutes(15);

    private static final Duration MIN_BACKOFF = Duration.ofSeconds(30);
    private static final Duration MAX_BACKOFF = Duration.ofMinutes(10);

    public enum Kind {
        /** Answered from the cache, no call made. */
        CACHED,
        /** A real call was made; {@code result} is its (uncached) answer. */
        CALLED,
        /** No call made: paced, over budget or cooling down. {@code result} is null. */
        SKIPPED
    }

    public record Outcome(Kind kind, LookupResult result) {
        static final Outcome SKIPPED = new Outcome(Kind.SKIPPED, null);
    }

    /** Answer to {@link #board}; {@code board} is null only for SKIPPED. */
    public record BoardOutcome(Kind kind, BoardResult board) {
        static final BoardOutcome SKIPPED = new BoardOutcome(Kind.SKIPPED, null);
    }

    private record CacheKey(String providerId, String callsign, String airport, LocalDate utcDate) { }

    private record CacheEntry(LookupResult result, Instant cachedAt, Instant expiresAt) { }

    private record BoardKey(String providerId, String airport, LocalDate utcDate) { }

    private record BoardCacheEntry(BoardResult board, Instant fetchedAt, Instant expiresAt) { }

    /** Per-provider pacing state. Guarded by its own monitor. */
    private static final class ProviderState {
        final PollBackoff backoff = new PollBackoff();
        Instant lastCallAt = Instant.EPOCH;
    }

    private final Clock clock;
    private final Duration minInterval;
    private final ConfirmationBudgets budgets;
    private final int maxCacheEntries;
    private final Duration skewTolerance;
    private final Duration maxRetryAfter;
    private final Duration boardTtl;
    private final int maxBoardEntries;

    private final Map<String, ProviderState> providers = new HashMap<>();
    private final LinkedHashMap<CacheKey, CacheEntry> cache = new LinkedHashMap<>(256, 0.75f, true);
    private final LinkedHashMap<BoardKey, BoardCacheEntry> boards = new LinkedHashMap<>(32, 0.75f, true);

    public ConfirmationGateway(Clock clock,
                               @Value("${flighttracker.confirmation.min-interval-seconds:30}") long minIntervalSeconds,
                               ConfirmationBudgets budgets,
                               @Value("${flighttracker.confirmation.cache-max-entries:2000}") int maxCacheEntries,
                               @Value("${flighttracker.confirmation.skew-tolerance-seconds:300}") long skewToleranceSeconds,
                               @Value("${flighttracker.confirmation.max-retry-after-minutes:60}") long maxRetryAfterMinutes,
                               @Value("${flighttracker.confirmation.board-ttl-seconds:300}") long boardTtlSeconds,
                               @Value("${flighttracker.confirmation.board-max-entries:100}") int maxBoardEntries) {
        this.clock = clock;
        this.minInterval = Duration.ofSeconds(minIntervalSeconds);
        this.budgets = budgets;
        this.maxCacheEntries = maxCacheEntries;
        this.skewTolerance = Duration.ofSeconds(skewToleranceSeconds);
        this.maxRetryAfter = Duration.ofMinutes(maxRetryAfterMinutes);
        this.boardTtl = Duration.ofSeconds(boardTtlSeconds);
        this.maxBoardEntries = maxBoardEntries;
    }

    /** Cached answer, or one real call if the pacing, budget and backoff allow it. */
    public Outcome lookup(ArrivalConfirmationProvider provider, ArrivalQuery query) {
        Instant now = clock.instant();
        CacheKey key = new CacheKey(provider.id(), normalize(query.callsign()),
                query.arrivalAirportIcao() == null ? "?" : query.arrivalAirportIcao(),
                query.expectedArrivalAt() == null ? LocalDate.EPOCH : query.expectedArrivalAt().atZone(ZoneOffset.UTC).toLocalDate());

        synchronized (cache) {
            CacheEntry hit = cache.get(key);
            if (hit != null) {
                if (hit.expiresAt().isAfter(now) && !isEarlierLeg(hit, query, now, foundTtl(provider))) {
                    return new Outcome(Kind.CACHED, hit.result());
                }
                cache.remove(key);
            }
        }

        // A query the provider can never answer costs nothing and is not a call: no charge, no
        // pacing, and the caller goes on to its next candidate. Not cached; the check is free.
        if (!provider.accepts(query)) return new Outcome(Kind.CACHED, LookupResult.notFound());

        int units = Math.max(1, provider.callCost());
        ProviderState state = admit(provider.id(), units, now);
        if (state == null) return Outcome.SKIPPED;

        LookupResult result;
        try {
            result = provider.lookup(query);
        } catch (RuntimeException e) {
            log.warn("Confirmation provider {} threw", provider.id(), e);
            result = LookupResult.failed();
        }
        if (result == null) result = LookupResult.failed();
        refundUnreached(provider.id(), units, result);

        if (result.status() == LookupResult.Status.FOUND || result.status() == LookupResult.Status.NOT_FOUND) {
            recordSuccess(state);
            Duration ttl = ttl(result, provider);
            synchronized (cache) {
                cache.put(key, new CacheEntry(result, now, now.plus(ttl)));
                evictOverflow();
            }
        } else {
            recordFailure(provider.id(), state, result.status(), result.retryAfter());
        }
        return new Outcome(Kind.CALLED, result);
    }

    /**
     * Gives back what a call charged but never used: all of it for THROTTLED (the upstream
     * rejected it before doing the work), and down to {@code costUnits} when the provider
     * reports one (0 for a request that never got an HTTP response). A 5xx or other error
     * answer keeps its charge: the upstream may have billed it.
     */
    private void refundUnreached(String providerId, int charged, LookupResult result) {
        int used = result.status() == LookupResult.Status.THROTTLED ? 0
                : result.costUnits() == null ? charged : Math.min(charged, result.costUnits());
        budgets.adjust(providerId, used - charged);
    }

    /**
     * The arrivals board of one airport and UTC date: the cached one while it is
     * fresh, else one real fetch if the pacing, budgets and backoff allow it.
     * FOUND and NOT_FOUND boards are cached for {@code board-ttl-seconds};
     * THROTTLED and FAILED never are.
     */
    public BoardOutcome board(AirportArrivalsProvider provider, String airportIcao, LocalDate utcDate) {
        Instant now = clock.instant();
        BoardKey key = boardKey(provider, airportIcao, utcDate);
        Optional<BoardResult> hit = freshBoard(key, now);
        if (hit.isPresent()) return new BoardOutcome(Kind.CACHED, hit.get());

        ProviderState state = admit(provider.id(), 1, now);
        if (state == null) return BoardOutcome.SKIPPED;

        BoardResult result;
        try {
            result = provider.fetchArrivals(airportIcao, utcDate);
        } catch (RuntimeException e) {
            log.warn("Confirmation provider {} threw", provider.id(), e);
            result = BoardResult.failed();
        }
        if (result == null) result = BoardResult.failed();
        budgets.adjust(provider.id(), result.costUnits() - 1); // one unit was charged before the call

        if (result.status() == LookupResult.Status.FOUND || result.status() == LookupResult.Status.NOT_FOUND) {
            recordSuccess(state);
            synchronized (boards) {
                boards.put(key, new BoardCacheEntry(result, now, now.plus(boardTtl)));
                evictBoardOverflow(now);
            }
        } else {
            recordFailure(provider.id(), state, result.status(), result.retryAfter());
        }
        return new BoardOutcome(Kind.CALLED, result);
    }

    /** The board if it is cached and fresh; never makes a call. */
    public Optional<BoardResult> cachedBoard(AirportArrivalsProvider provider, String airportIcao, LocalDate utcDate) {
        return freshBoard(boardKey(provider, airportIcao, utcDate), clock.instant());
    }

    /** When the fresh cached board was fetched; empty if there is none. Never makes a call. */
    public Optional<Instant> boardFetchedAt(AirportArrivalsProvider provider, String airportIcao, LocalDate utcDate) {
        BoardKey key = boardKey(provider, airportIcao, utcDate);
        Instant now = clock.instant();
        synchronized (boards) {
            BoardCacheEntry hit = boards.get(key);
            return hit != null && hit.expiresAt().isAfter(now) ? Optional.of(hit.fetchedAt()) : Optional.empty();
        }
    }

    private static BoardKey boardKey(AirportArrivalsProvider provider, String airportIcao, LocalDate utcDate) {
        return new BoardKey(provider.id(), airportIcao == null ? "?" : airportIcao.trim().toUpperCase(Locale.ROOT), utcDate);
    }

    private Optional<BoardResult> freshBoard(BoardKey key, Instant now) {
        synchronized (boards) {
            BoardCacheEntry hit = boards.get(key);
            if (hit == null) return Optional.empty();
            if (hit.expiresAt().isAfter(now)) return Optional.of(hit.board());
            boards.remove(key);
            return Optional.empty();
        }
    }

    /**
     * The gate in front of every real call: not cooling down, the minimum
     * interval has passed and the budgets have room for {@code units}. Returns
     * the provider's state with the call already counted, or null to skip.
     */
    private ProviderState admit(String providerId, int units, Instant now) {
        ProviderState state;
        synchronized (providers) {
            state = providers.computeIfAbsent(providerId, id -> new ProviderState());
        }
        synchronized (state.backoff) {
            if (state.backoff.isCoolingDown(now)) return null;
            if (now.isBefore(state.lastCallAt.plus(minInterval))) return null;
            if (!budgets.tryCharge(providerId, units)) return null;
            state.lastCallAt = now;
        }
        return state;
    }

    private void recordSuccess(ProviderState state) {
        synchronized (state.backoff) {
            state.backoff.recordSuccess();
        }
    }

    private void recordFailure(String providerId, ProviderState state, LookupResult.Status status, Duration retryAfter) {
        Duration wait;
        synchronized (state.backoff) {
            if (retryAfter != null && !retryAfter.isNegative()) {
                wait = retryAfter.compareTo(maxRetryAfter) > 0 ? maxRetryAfter : retryAfter;
                state.backoff.recordFailure(wait);
            } else {
                wait = state.backoff.recordFailure(MIN_BACKOFF, MAX_BACKOFF);
            }
        }
        log.warn("Confirmation provider {} answered {}, backing off {}", providerId, status, wait);
    }

    /**
     * A cached FOUND that landed before this query's expected arrival is an
     * earlier leg of the same callsign (a GA aircraft doing circuits, a daily
     * flight). It counts as a miss, but at most once per {@link #TTL_FOUND_NO_IN}:
     * a provider that keeps answering with the old leg must not be asked on
     * every tick.
     */
    private boolean isEarlierLeg(CacheEntry hit, ArrivalQuery query, Instant now, Duration recheck) {
        if (hit.result().status() != LookupResult.Status.FOUND || hit.result().info() == null) return false;
        Instant landedAt = hit.result().info().landedAt();
        Instant expected = query.expectedArrivalAt();
        if (landedAt == null || expected == null) return false;
        if (!landedAt.isBefore(expected.minus(skewTolerance))) return false;
        return !hit.cachedAt().plus(recheck).isAfter(now);
    }

    /** Budget units charged to the provider today (UTC), for tests and logs. */
    public int unitsToday(String providerId) {
        return budgets.unitsToday(providerId);
    }

    /** Budget units charged to the provider this UTC month. */
    public int unitsThisMonth(String providerId) {
        return budgets.unitsThisMonth(providerId);
    }

    public int cacheSize() {
        synchronized (cache) {
            return cache.size();
        }
    }

    public int boardCacheSize() {
        synchronized (boards) {
            return boards.size();
        }
    }

    /** The provider's own recheck interval, but never shorter than the gateway default. */
    private static Duration atLeast(Duration floor, Duration provided) {
        return provided != null && provided.compareTo(floor) > 0 ? provided : floor;
    }

    /** How long a FOUND without a gate-in time is kept (and how often an earlier-leg answer is re-asked). */
    static Duration foundTtl(ArrivalConfirmationProvider provider) {
        return atLeast(TTL_FOUND_NO_IN, provider.foundRecheck());
    }

    static Duration ttl(LookupResult result, ArrivalConfirmationProvider provider) {
        if (result.status() == LookupResult.Status.NOT_FOUND) return atLeast(TTL_NOT_FOUND, provider.notFoundRecheck());
        return result.info() != null && result.info().actualIn() != null ? TTL_FOUND_IN : foundTtl(provider);
    }

    /** Caller holds the cache monitor. Drops expired entries first, then the least recently used. */
    private void evictOverflow() {
        if (cache.size() <= maxCacheEntries) return;
        Instant now = clock.instant();
        cache.values().removeIf(e -> !e.expiresAt().isAfter(now));
        var it = cache.entrySet().iterator();
        while (cache.size() > maxCacheEntries && it.hasNext()) {
            it.next();
            it.remove();
        }
    }

    /** Caller holds the boards monitor. Drops expired boards first, then the least recently used. */
    private void evictBoardOverflow(Instant now) {
        if (boards.size() <= maxBoardEntries) return;
        boards.values().removeIf(e -> !e.expiresAt().isAfter(now));
        var it = boards.entrySet().iterator();
        while (boards.size() > maxBoardEntries && it.hasNext()) {
            it.next();
            it.remove();
        }
    }

    private static String normalize(String callsign) {
        return callsign == null ? "" : callsign.trim().toUpperCase(Locale.ROOT);
    }
}
