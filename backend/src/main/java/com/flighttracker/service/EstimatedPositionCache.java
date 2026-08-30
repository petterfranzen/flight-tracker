package com.flighttracker.service;

import com.flighttracker.model.Aircraft;
import com.flighttracker.model.FlightPosition;
import com.flighttracker.repository.AircraftRepository;
import com.flighttracker.repository.FlightPositionRepository;
import org.springframework.context.annotation.Profile;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Function;
import java.util.stream.Collectors;

/**
 * Keeps a live, continuously-refreshed "best current position" per
 * aircraft — real where a recent-enough report exists, dead-reckoned
 * (EstimatedPositionService) otherwise — so FlightController's /live and
 * /search responses can serve it directly instead of leaving the frontend
 * to guess where a stale aircraft actually is. This is the "heavy
 * lifting" (the trig, the batched destination lookups) happening
 * server-side on its own fixed schedule, decoupled entirely from how
 * often — or whether — any client happens to be asking: the frontend just
 * gets back a list of positions and renders them, with no way to tell,
 * and no need to care, which ones were dead-reckoned. It doesn't get a
 * flag for that, and it doesn't get the destination coordinates this
 * needs to compute it either — those are internal to this refresh cycle.
 *
 * REFRESH_INTERVAL is independent of any request cadence: this recomputes
 * every 10 seconds regardless of whether zero, one, or a hundred clients
 * are currently fetching /live. A single in-memory volatile map (not a
 * DB table) is enough — this only ever needs to be read by the same JVM
 * that writes it (the "api" container's own HTTP handlers), unlike
 * PollWindowService's poll_window table, which is DB-backed specifically
 * because the "api" and "agent" containers are separate processes that
 * both need to see the same state.
 */
@Service
@Profile("api")
public class EstimatedPositionCache {

    private static final long REFRESH_INTERVAL_MS = 10_000;

    private final FlightPositionRepository positionRepository;
    private final AircraftRepository aircraftRepository;

    // Swapped wholesale on every refresh (never mutated in place), so a
    // concurrent read from overlay() always sees one fully-consistent
    // snapshot — either the previous cycle's or the new one's, never a
    // partially-rebuilt map.
    private volatile Map<String, FlightPosition> current = Map.of();

    public EstimatedPositionCache(FlightPositionRepository positionRepository, AircraftRepository aircraftRepository) {
        this.positionRepository = positionRepository;
        this.aircraftRepository = aircraftRepository;
    }

    @Scheduled(fixedRate = REFRESH_INTERVAL_MS)
    void refresh() {
        Instant now = Instant.now();
        List<FlightPosition> live = positionRepository.findLive(
                now.minus(LiveVisibilityWindows.STALE_AIRBORNE_BOUND),
                now.minus(LiveVisibilityWindows.LANDED_VISIBILITY),
                now.minus(LiveVisibilityWindows.PRESUMED_LANDED_SILENCE),
                LiveVisibilityWindows.DESCENDING_VERTICAL_RATE_MS);

        if (live.isEmpty()) {
            current = Map.of();
            return;
        }

        // One batched lookup for every aircraft in this cycle rather than
        // a query each — EstimatedPositionService needs each one's filed
        // destination (see its javadoc for why), which FlightPosition
        // itself doesn't carry.
        List<String> icao24s = live.stream().map(FlightPosition::getIcao24).distinct().toList();
        Map<String, Aircraft> byIcao24 = aircraftRepository.findAllById(icao24s).stream()
                .collect(Collectors.toMap(Aircraft::getIcao24, Function.identity()));

        Map<String, FlightPosition> next = new HashMap<>();
        for (FlightPosition p : live) {
            Aircraft a = byIcao24.get(p.getIcao24());
            Double destLat = a == null ? null : a.getDestinationAirportLat();
            Double destLon = a == null ? null : a.getDestinationAirportLon();
            next.put(p.getIcao24(), EstimatedPositionService.estimate(p, now, destLat, destLon));
        }
        current = next;
    }

    /**
     * Overlays this cache's current best-guess positions onto {@code rows}
     * — for each row whose icao24 has a cached entry at least as fresh
     * (same-or-newer observedAt) as the row itself, the cached position
     * (possibly dead-reckoned forward of it) is used in its place;
     * otherwise the row passes through unchanged. "At least as fresh," not
     * strictly newer: a cached entry projected from the *same* real report
     * a query just returned is exactly the case this exists to improve on
     * — its position has had up to REFRESH_INTERVAL_MS longer to advance
     * than the raw row's unprojected one. A cached entry can never be
     * older than the row it'd replace by more than one refresh cycle, and
     * safely loses to a genuinely newer row (a real report landing between
     * refreshes) by that same comparison.
     *
     * Safe to call with results from any live/search query, bbox-scoped or
     * not — the cache itself is always built from the whole (bbox-less)
     * live set, so a lookup by icao24 works regardless of what the
     * caller's own query was scoped to. A row for an aircraft this cache
     * doesn't have (or no longer has, e.g. it just aged out) an opinion on
     * simply passes through untouched.
     */
    public List<FlightPosition> overlay(List<FlightPosition> rows) {
        if (rows.isEmpty()) return rows;
        Map<String, FlightPosition> snapshot = current; // one volatile read, consistent for the whole call
        return rows.stream().map(p -> {
            FlightPosition cached = snapshot.get(p.getIcao24());
            return (cached != null && !cached.getObservedAt().isBefore(p.getObservedAt())) ? cached : p;
        }).toList();
    }
}
