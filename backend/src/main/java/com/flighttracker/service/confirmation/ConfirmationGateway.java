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

/**
 * The one place a provider is called from. It gives every provider the same
 * protections, so a provider only maps a request to a response:
 *
 * <ul>
 *   <li>a result cache keyed by (provider, callsign, arrival airport, UTC date
 *       of the expected arrival), bounded, with a TTL by outcome: FOUND without
 *       a gate-in time {@value #TTL_FOUND_MINUTES_NO_IN} min (the gate may still
 *       come), FOUND with one 12 h, NOT_FOUND 15 min. THROTTLED and FAILED are
 *       never cached;</li>
 *   <li>a minimum interval between two real calls to the same provider;</li>
 *   <li>a daily call budget per provider (UTC day), for free tiers with a quota;</li>
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

    private record CacheKey(String providerId, String callsign, String airport, LocalDate utcDate) { }

    private record CacheEntry(LookupResult result, Instant cachedAt, Instant expiresAt) { }

    /** Per-provider pacing state. Guarded by its own monitor. */
    private static final class ProviderState {
        final PollBackoff backoff = new PollBackoff();
        Instant lastCallAt = Instant.EPOCH;
        LocalDate budgetDay;
        int callsToday;
    }

    private final Clock clock;
    private final Duration minInterval;
    private final int dailyBudget;
    private final int maxCacheEntries;
    private final Duration skewTolerance;
    private final Duration maxRetryAfter;

    private final Map<String, ProviderState> providers = new HashMap<>();
    private final LinkedHashMap<CacheKey, CacheEntry> cache = new LinkedHashMap<>(256, 0.75f, true);

    public ConfirmationGateway(Clock clock,
                               @Value("${flighttracker.confirmation.min-interval-seconds:30}") long minIntervalSeconds,
                               @Value("${flighttracker.confirmation.daily-budget:300}") int dailyBudget,
                               @Value("${flighttracker.confirmation.cache-max-entries:2000}") int maxCacheEntries,
                               @Value("${flighttracker.confirmation.skew-tolerance-seconds:300}") long skewToleranceSeconds,
                               @Value("${flighttracker.confirmation.max-retry-after-minutes:60}") long maxRetryAfterMinutes) {
        this.clock = clock;
        this.minInterval = Duration.ofSeconds(minIntervalSeconds);
        this.dailyBudget = dailyBudget;
        this.maxCacheEntries = maxCacheEntries;
        this.skewTolerance = Duration.ofSeconds(skewToleranceSeconds);
        this.maxRetryAfter = Duration.ofMinutes(maxRetryAfterMinutes);
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
                if (hit.expiresAt().isAfter(now) && !isEarlierLeg(hit, query, now)) {
                    return new Outcome(Kind.CACHED, hit.result());
                }
                cache.remove(key);
            }
        }

        ProviderState state;
        synchronized (providers) {
            state = providers.computeIfAbsent(provider.id(), id -> new ProviderState());
        }
        synchronized (state.backoff) {
            if (state.backoff.isCoolingDown(now)) return Outcome.SKIPPED;
            if (now.isBefore(state.lastCallAt.plus(minInterval))) return Outcome.SKIPPED;
            LocalDate today = now.atZone(ZoneOffset.UTC).toLocalDate();
            if (!today.equals(state.budgetDay)) {
                state.budgetDay = today;
                state.callsToday = 0;
            }
            if (state.callsToday >= dailyBudget) return Outcome.SKIPPED;
            state.callsToday++;
            state.lastCallAt = now;
        }

        LookupResult result;
        try {
            result = provider.lookup(query);
        } catch (RuntimeException e) {
            log.warn("Confirmation provider {} threw", provider.id(), e);
            result = LookupResult.failed();
        }
        if (result == null) result = LookupResult.failed();

        switch (result.status()) {
            case FOUND, NOT_FOUND -> {
                synchronized (state.backoff) {
                    state.backoff.recordSuccess();
                }
                Duration ttl = ttl(result);
                synchronized (cache) {
                    cache.put(key, new CacheEntry(result, now, now.plus(ttl)));
                    evictOverflow();
                }
            }
            case THROTTLED, FAILED -> {
                Duration wait;
                synchronized (state.backoff) {
                    if (result.retryAfter() != null && !result.retryAfter().isNegative()) {
                        wait = result.retryAfter().compareTo(maxRetryAfter) > 0 ? maxRetryAfter : result.retryAfter();
                        state.backoff.recordFailure(wait);
                    } else {
                        wait = state.backoff.recordFailure(MIN_BACKOFF, MAX_BACKOFF);
                    }
                }
                log.warn("Confirmation provider {} answered {}, backing off {}", provider.id(), result.status(), wait);
            }
        }
        return new Outcome(Kind.CALLED, result);
    }

    /**
     * A cached FOUND that landed before this query's expected arrival is an
     * earlier leg of the same callsign (a GA aircraft doing circuits, a daily
     * flight). It counts as a miss, but at most once per {@link #TTL_FOUND_NO_IN}:
     * a provider that keeps answering with the old leg must not be asked on
     * every tick.
     */
    private boolean isEarlierLeg(CacheEntry hit, ArrivalQuery query, Instant now) {
        if (hit.result().status() != LookupResult.Status.FOUND || hit.result().info() == null) return false;
        Instant landedAt = hit.result().info().landedAt();
        Instant expected = query.expectedArrivalAt();
        if (landedAt == null || expected == null) return false;
        if (!landedAt.isBefore(expected.minus(skewTolerance))) return false;
        return !hit.cachedAt().plus(TTL_FOUND_NO_IN).isAfter(now);
    }

    /** Real calls made to the provider today (UTC), for tests and logs. */
    public int callsToday(String providerId) {
        ProviderState state;
        synchronized (providers) {
            state = providers.get(providerId);
        }
        if (state == null) return 0;
        synchronized (state.backoff) {
            return today().equals(state.budgetDay) ? state.callsToday : 0;
        }
    }

    public int cacheSize() {
        synchronized (cache) {
            return cache.size();
        }
    }

    private LocalDate today() {
        return clock.instant().atZone(ZoneOffset.UTC).toLocalDate();
    }

    static Duration ttl(LookupResult result) {
        if (result.status() == LookupResult.Status.NOT_FOUND) return TTL_NOT_FOUND;
        return result.info() != null && result.info().actualIn() != null ? TTL_FOUND_IN : TTL_FOUND_NO_IN;
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

    private static String normalize(String callsign) {
        return callsign == null ? "" : callsign.trim().toUpperCase(Locale.ROOT);
    }
}
