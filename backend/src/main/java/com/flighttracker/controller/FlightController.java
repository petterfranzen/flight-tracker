package com.flighttracker.controller;

import com.flighttracker.dto.Bounds;
import com.flighttracker.dto.ClusterPoint;
import com.flighttracker.model.FlightPosition;
import com.flighttracker.repository.FlightPositionRepository;
import com.flighttracker.service.LiveVisibilityWindows;
import com.flighttracker.service.ViewportService;
import org.springframework.context.annotation.Profile;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.time.Instant;
import java.util.List;

@RestController
@RequestMapping("/api/flights")
@Profile("api")
public class FlightController {

    private final FlightPositionRepository positionRepository;
    private final ViewportService viewportService;

    public FlightController(FlightPositionRepository positionRepository, ViewportService viewportService) {
        this.positionRepository = positionRepository;
        this.viewportService = viewportService;
    }

    /**
     * Latest known position per aircraft, for the initial map paint
     * (WebSocket carries updates after that). Tracking is global, but a
     * client normally passes its current map viewport (all four bbox
     * params) to get back only what's visible — otherwise every aircraft
     * being tracked anywhere is returned, which is what the bbox-less form
     * is for (e.g. a fleet-wide check), not what the map UI calls with.
     *
     * Passing a bbox also reports it as the current viewport (see
     * ViewportService) — this is what tells the "agent" container's hot
     * poll, and this container's WebSocket broadcast filtering, what's
     * actually on someone's screen right now.
     *
     * Every row already carries EstimatorAgent's current best-guess
     * position where one exists — see FlightPositionRepository.
     * LATEST_COLUMNS, which COALESCEs estimated_latitude/
     * estimated_longitude over the raw ones for every reader of this
     * table, so there's nothing to do here beyond the plain query: no
     * per-endpoint overlay step to remember, unlike the old
     * EstimatedPositionCache.overlay() this replaced.
     */
    @GetMapping("/live")
    public List<FlightPosition> live(@RequestParam(required = false) Double latMin,
                                      @RequestParam(required = false) Double latMax,
                                      @RequestParam(required = false) Double lonMin,
                                      @RequestParam(required = false) Double lonMax) {
        Instant now = Instant.now();
        Instant staleAirborneCutoff = now.minus(LiveVisibilityWindows.STALE_AIRBORNE_BOUND);
        Instant landedCutoff = now.minus(LiveVisibilityWindows.LANDED_VISIBILITY);

        if (latMin == null || latMax == null || lonMin == null || lonMax == null) {
            return positionRepository.findLive(staleAirborneCutoff, landedCutoff);
        }
        Bounds bounds = new Bounds(latMin, latMax, lonMin, lonMax);
        viewportService.report(bounds);
        return positionRepository.findLiveInBounds(staleAirborneCutoff, landedCutoff,
                bounds.latMin(), bounds.latMax(), bounds.lonMin(), bounds.lonMax());
    }

    /**
     * Global counterpart to /live's own bbox-less form, minus the cost of
     * fetching every row just to measure how many there are — the map's
     * "TRACKED" chip wants a worldwide total regardless of the current
     * viewport, refreshed alongside every /live poll, so this stays a
     * plain count rather than reusing the bbox-less list endpoint.
     */
    @GetMapping("/live/count")
    public long liveCount() {
        Instant now = Instant.now();
        return positionRepository.countLive(
                now.minus(LiveVisibilityWindows.STALE_AIRBORNE_BOUND),
                now.minus(LiveVisibilityWindows.LANDED_VISIBILITY));
    }

    /**
     * Single-aircraft counterpart to /live, for the map's priority refresh
     * of whichever aircraft is currently selected (see the dedicated poll
     * in FlightMap.tsx). The bbox-scoped /live above — and the WebSocket
     * feed, which is filtered server-side by whatever bbox /live last
     * reported (see ViewportService/LiveFeedBroadcaster) — both simply stop
     * delivering anything for an aircraft once it leaves the last-reported
     * viewport, or once the map is zoomed out past CLUSTER_FETCH_MAX_ZOOM
     * and stops reporting a per-aircraft viewport at all. A selected
     * aircraft shouldn't go stale in the details panel just because of
     * that — this looks it up directly by icao24, independent of any
     * viewport. Deliberately does not call viewportService.report(): a
     * lookup here isn't "what's on screen," and shouldn't perturb what the
     * hot-poll/broadcast are currently tracking on that basis.
     *
     * Not scoped to LiveVisibilityWindows' staleness cutoffs the way /live
     * is — an aircraft already selected should keep showing its true last-
     * known position (with the frontend's own staleness warning) rather
     * than silently disappearing from this endpoint once it ages past a
     * cutoff meant for deciding what's worth putting on the map in the
     * first place.
     */
    @GetMapping("/{icao24}/live")
    public ResponseEntity<FlightPosition> liveOne(@PathVariable String icao24) {
        return positionRepository.findLatestPosition(icao24)
                .map(ResponseEntity::ok)
                .orElseGet(() -> ResponseEntity.notFound().build());
    }

    // Below this, a grid cell would be finer than markers are distinguishable
    // at anyway, so there's nothing to gain over just returning individual
    // positions — and above it a client-requested finer grid would just
    // shift the "too many rows/markers" problem from aircraft to cells.
    // 25° covers the frontend's actual worst case (minZoom=2 asks for
    // ~22.5°, sized off screen pixel spacing — see gridDegForZoom in
    // FlightMap.tsx) with a little headroom, rather than silently clamping
    // it down and re-introducing the overlapping-cluster crowding that
    // sizing was specifically computed to avoid.
    private static final double MIN_CLUSTER_GRID_DEG = 0.5;
    private static final double MAX_CLUSTER_GRID_DEG = 25;

    /**
     * Aggregated view of /live for viewports too large to usefully show
     * individual aircraft — a continent or the whole world can mean tens
     * of thousands of live rows, which is both a lot to transfer and (more
     * to the point) a lot for the client to turn into markers and cluster
     * itself. This does the clustering here instead: one row per populated
     * gridDeg-sized cell rather than one per aircraft.
     *
     * Deliberately does NOT call viewportService.report() the way /live
     * does: that's what tells LiveFeedBroadcaster which aircraft to push
     * over the WebSocket, and a client in aggregated-cluster mode isn't
     * rendering individual aircraft at all — reporting a continent- or
     * world-sized bbox as "the current viewport" would make the
     * broadcaster start pushing every aircraft in it to a client that has
     * nowhere to put those updates. Leaving the reported viewport alone
     * means hot-poll/broadcast keep reflecting whatever real, individual-
     * aircraft viewport was last in effect.
     *
     * Buckets on the same COALESCE(estimated_latitude, latitude) (and
     * longitude) expression LATEST_COLUMNS reads elsewhere — see
     * FlightPositionRepository.findLiveClusteredInBounds — so a dead-
     * reckoned aircraft lands in the same cell here as its marker would
     * render at once zoomed in past CLUSTER_FETCH_MAX_ZOOM. No separate
     * overlay step needed: the aggregation query itself already reads
     * EstimatorAgent's current estimate directly off the row.
     */
    @GetMapping("/live/clusters")
    public List<ClusterPoint> liveClusters(@RequestParam double latMin,
                                            @RequestParam double latMax,
                                            @RequestParam double lonMin,
                                            @RequestParam double lonMax,
                                            @RequestParam(defaultValue = "2") double gridDeg) {
        Instant now = Instant.now();
        Bounds bounds = new Bounds(latMin, latMax, lonMin, lonMax);
        double clampedGridDeg = Math.min(MAX_CLUSTER_GRID_DEG, Math.max(MIN_CLUSTER_GRID_DEG, gridDeg));
        return positionRepository.findLiveClusteredInBounds(
                now.minus(LiveVisibilityWindows.STALE_AIRBORNE_BOUND), now.minus(LiveVisibilityWindows.LANDED_VISIBILITY),
                bounds.latMin(), bounds.latMax(), bounds.lonMin(), bounds.lonMax(),
                clampedGridDeg);
    }

    private static final int SEARCH_RESULT_LIMIT = 8;

    /**
     * Search-box autocomplete: live aircraft whose callsign matches `q`,
     * for "type a flight number, zoom to the plane" (see FlightSearch.tsx).
     * `airport` backs the separate "advanced search" panel's single
     * airport field instead — matches an aircraft whose origin OR
     * destination airport matches (name, IATA code, ICAO code, or city);
     * when given, it takes over from `q` entirely rather than combining
     * with it (the two are presented as distinct search modes in the UI,
     * not one merged query). See FlightPositionRepository.searchLive and
     * .searchByAirport for ranking/matching details.
     */
    @GetMapping("/search")
    public List<FlightPosition> search(@RequestParam(required = false) String q,
                                        @RequestParam(required = false) String airport) {
        Instant now = Instant.now();
        Instant staleAirborneCutoff = now.minus(LiveVisibilityWindows.STALE_AIRBORNE_BOUND);
        Instant landedCutoff = now.minus(LiveVisibilityWindows.LANDED_VISIBILITY);

        String trimmedAirport = airport == null ? "" : airport.trim();
        if (!trimmedAirport.isEmpty()) {
            return positionRepository.searchByAirport(
                    "%" + escapeLike(trimmedAirport) + "%",
                    staleAirborneCutoff, landedCutoff, SEARCH_RESULT_LIMIT);
        }

        String trimmed = q == null ? "" : q.trim();
        if (trimmed.isEmpty()) return List.of();
        String escaped = escapeLike(trimmed);
        // Picking a search result flies the map to p.latitude/p.longitude
        // directly (see FlightSearch.tsx) — LATEST_COLUMNS already reads
        // EstimatorAgent's current estimate for that, same as every other
        // reader, so it lands on the same best-current-estimate spot the
        // live view will show it at, not a possibly stale fix.
        return positionRepository.searchLive(
                "%" + escaped + "%", escaped + "%",
                staleAirborneCutoff, landedCutoff, SEARCH_RESULT_LIMIT);
    }

    // So a literal % or _ typed by the user matches itself instead of
    // acting as a SQL LIKE wildcard.
    private static String escapeLike(String s) {
        return s.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_");
    }

    /** Full historic track for one aircraft, for the "trace the route across the map" view. */
    @GetMapping("/{icao24}/history")
    public List<FlightPosition> history(@PathVariable String icao24,
                                         @RequestParam Instant from,
                                         @RequestParam Instant to) {
        return positionRepository.findByIcao24AndObservedAtBetweenOrderByObservedAtAsc(icao24, from, to);
    }
}
