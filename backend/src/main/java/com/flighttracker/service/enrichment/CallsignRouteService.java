package com.flighttracker.service.enrichment;

import com.flighttracker.dto.Bounds;
import com.flighttracker.repository.CallsignRouteRepository;
import com.flighttracker.service.LiveVisibilityWindows;
import com.flighttracker.service.ViewportService;
import com.flighttracker.service.live.LiveAircraft;
import com.flighttracker.service.live.LiveStateStore;
import jakarta.annotation.PostConstruct;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Queue;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentLinkedQueue;

/**
 * Origin/destination per *callsign* — what a flight actually is. Airlines
 * fly a new flight number on every leg, so keying the route by callsign
 * means a turnaround (AMS→ARN, then ARN→AMS under another number) picks up
 * the new route by itself. The aircraft table used to hold one route per
 * airframe, fetched once and never refreshed, which showed finished legs as
 * the current destination.
 *
 * Two ways a callsign gets resolved, both against adsbdb's schedule-based
 * callsign database (resolves airborne flights, unlike OpenSky's
 * historical-flights endpoint):
 *  - resolve(): synchronously, for one dossier request.
 *  - resolveNext(): a paced background walk over every live callsign not
 *    yet cached, one lookup per tick. This is what makes airport search
 *    work: it can only match flights whose route is known, and before this
 *    that was only aircraft someone had opened a dossier for. Eagerly
 *    enriching everything via the async pool overwhelmed rate limits in
 *    the past (see AircraftEnrichmentService) — this is one request at a
 *    time on a fixed cadence, backing off on 429, so a ~10k-callsign first
 *    pass takes about an hour at the default 2/s and only new callsigns
 *    after that.
 *
 * Everything is cached in memory (a few hundred KB at most) and written
 * through to callsign_route so a restart doesn't start the walk over.
 */
@Service
public class CallsignRouteService {

    private static final Logger log = LoggerFactory.getLogger(CallsignRouteService.class);

    // Flight-number routes change with schedule seasons, not daily.
    static final Duration FOUND_TTL = Duration.ofDays(3);
    // A miss (charter/GA/military, or not in adsbdb yet) is retried sooner.
    static final Duration MISS_TTL = Duration.ofHours(24);
    static final Duration REFILL_INTERVAL = Duration.ofSeconds(60);
    static final Duration FAILURE_PAUSE = Duration.ofSeconds(30);
    static final Duration MIN_THROTTLE_PAUSE = Duration.ofSeconds(60);
    static final Duration MAX_THROTTLE_PAUSE = Duration.ofMinutes(15);

    record Entry(Route route, Instant fetchedAt) {
        boolean fresh(Instant now) {
            Duration ttl = route != null ? FOUND_TTL : MISS_TTL;
            return fetchedAt.plus(ttl).isAfter(now);
        }
    }

    private final AdsbdbClient adsbdbClient;
    private final CallsignRouteRepository repository;
    private final LiveStateStore liveStateStore;
    private final ViewportService viewportService;
    private final Clock clock;

    private final Map<String, Entry> cache = new ConcurrentHashMap<>();
    private final Queue<String> queue = new ConcurrentLinkedQueue<>();
    private final Set<String> queued = ConcurrentHashMap.newKeySet();
    private volatile Instant lastRefill = Instant.EPOCH;
    private volatile Instant pausedUntil = Instant.EPOCH;
    private volatile Duration throttlePause = Duration.ZERO;

    public CallsignRouteService(AdsbdbClient adsbdbClient,
                                CallsignRouteRepository repository,
                                LiveStateStore liveStateStore,
                                ViewportService viewportService,
                                Clock clock) {
        this.adsbdbClient = adsbdbClient;
        this.repository = repository;
        this.liveStateStore = liveStateStore;
        this.viewportService = viewportService;
        this.clock = clock;
    }

    @PostConstruct
    void load() {
        for (CallsignRouteRepository.Row row : repository.findAll()) {
            cache.put(row.callsign(), new Entry(row.route(), row.fetchedAt()));
        }
        log.info("Loaded {} cached callsign routes", cache.size());
    }

    /** Trimmed, upper-case; null for anything too short to be a flight number. */
    static String normalize(String callsign) {
        if (callsign == null) return null;
        String c = callsign.trim().toUpperCase(Locale.ROOT);
        return c.length() < 3 ? null : c;
    }

    /** Cached route only — never calls out. For bulk readers (airport search). */
    public Optional<Route> cached(String callsign) {
        String c = normalize(callsign);
        if (c == null) return Optional.empty();
        Entry e = cache.get(c);
        return e == null ? Optional.empty() : Optional.ofNullable(e.route());
    }

    /**
     * Cached route, or one synchronous adsbdb lookup if this callsign has
     * never been checked (or its entry has expired). For a single
     * user-triggered request only.
     */
    public Optional<Route> resolve(String callsign) {
        String c = normalize(callsign);
        if (c == null) return Optional.empty();
        Entry e = cache.get(c);
        if (e != null && e.fresh(clock.instant())) return Optional.ofNullable(e.route());
        if (clock.instant().isBefore(pausedUntil)) return e == null ? Optional.empty() : Optional.ofNullable(e.route());
        lookup(c);
        Entry after = cache.get(c);
        return after == null ? Optional.empty() : Optional.ofNullable(after.route());
    }

    /** One background lookup per tick; see the class javadoc. */
    @Scheduled(fixedDelayString = "${flighttracker.enrichment.callsign-route-interval-ms:500}",
            initialDelayString = "${flighttracker.enrichment.callsign-route-initial-delay-ms:30000}")
    public void resolveNext() {
        Instant now = clock.instant();
        if (now.isBefore(pausedUntil)) return;
        String next = queue.poll();
        if (next == null) {
            if (Duration.between(lastRefill, now).compareTo(REFILL_INTERVAL) < 0) return;
            refill(now);
            next = queue.poll();
            if (next == null) return;
        }
        queued.remove(next);
        Entry e = cache.get(next);
        if (e != null && e.fresh(now)) return;
        lookup(next);
    }

    private void lookup(String callsign) {
        AdsbdbClient.RouteLookup result = adsbdbClient.lookupRoute(callsign);
        Instant now = clock.instant();
        switch (result.status()) {
            case FOUND, NOT_FOUND -> {
                throttlePause = Duration.ZERO;
                Route route = result.route().orElse(null);
                cache.put(callsign, new Entry(route, now));
                repository.upsert(callsign, route, now);
            }
            case THROTTLED -> {
                Duration doubled = throttlePause.multipliedBy(2);
                throttlePause = doubled.compareTo(MIN_THROTTLE_PAUSE) < 0 ? MIN_THROTTLE_PAUSE
                        : doubled.compareTo(MAX_THROTTLE_PAUSE) > 0 ? MAX_THROTTLE_PAUSE : doubled;
                pausedUntil = now.plus(throttlePause);
                requeue(callsign);
                log.info("adsbdb throttled callsign lookups (429) — pausing {}s", throttlePause.toSeconds());
            }
            case FAILED -> {
                pausedUntil = now.plus(FAILURE_PAUSE);
                requeue(callsign);
            }
        }
    }

    private void requeue(String callsign) {
        if (queued.add(callsign)) queue.add(callsign);
    }

    /** Queues every live callsign without a fresh entry — on-screen ones first. */
    void refill(Instant now) {
        lastRefill = now;
        List<LiveAircraft> live = liveStateStore.liveAircraft(
                now.minus(LiveVisibilityWindows.STALE_AIRBORNE_BOUND), now.minus(LiveVisibilityWindows.LANDED_VISIBILITY));
        Bounds viewport = viewportService.current();
        List<String> onScreen = new ArrayList<>();
        List<String> rest = new ArrayList<>();
        for (LiveAircraft a : live) {
            String c = normalize(a.callsign());
            if (c == null || queued.contains(c)) continue;
            Entry e = cache.get(c);
            if (e != null && e.fresh(now)) continue;
            (viewport.contains(a.displayLatitude(), a.displayLongitude()) ? onScreen : rest).add(c);
        }
        onScreen.forEach(this::requeue);
        rest.forEach(this::requeue);
        if (!queue.isEmpty()) {
            log.info("Callsign routes: {} cached, {} queued for lookup", cache.size(), queue.size());
        }
    }
}
