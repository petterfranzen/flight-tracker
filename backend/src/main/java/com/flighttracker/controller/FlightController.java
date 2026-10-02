package com.flighttracker.controller;

import com.flighttracker.dto.Bounds;
import com.flighttracker.dto.ClusterPoint;
import com.flighttracker.dto.LiveMarker;
import com.flighttracker.dto.LiveOverview;
import com.flighttracker.model.FlightPosition;
import com.flighttracker.repository.AirportRepository;
import com.flighttracker.repository.FlightPositionRepository;
import com.flighttracker.service.LiveVisibilityWindows;
import com.flighttracker.service.ViewportService;
import com.flighttracker.service.enrichment.AircraftEnrichmentService;
import com.flighttracker.service.enrichment.Route;
import com.flighttracker.service.live.LiveAircraft;
import com.flighttracker.service.live.LiveStateStore;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.time.Instant;
import java.util.List;
import java.util.Locale;
import java.util.Set;

@RestController
@RequestMapping("/api/flights")
public class FlightController {

    private final LiveStateStore liveStateStore;
    private final FlightPositionRepository positionRepository;
    private final ViewportService viewportService;
    private final AircraftEnrichmentService enrichmentService;
    private final AirportRepository airportRepository;

    public FlightController(LiveStateStore liveStateStore,
                             FlightPositionRepository positionRepository,
                             ViewportService viewportService,
                             AircraftEnrichmentService enrichmentService,
                             AirportRepository airportRepository) {
        this.liveStateStore = liveStateStore;
        this.positionRepository = positionRepository;
        this.viewportService = viewportService;
        this.enrichmentService = enrichmentService;
        this.airportRepository = airportRepository;
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
     * ViewportService) — this is what tells the hot poll, and this
     * process's own WebSocket broadcast filtering, what's actually on
     * someone's screen right now.
     *
     * Every row already carries EstimatorAgent's current best-guess
     * position where one exists — see LiveAircraft.displayLatitude/
     * displayLongitude, which every LiveStateStore reader gets
     * automatically, so there's nothing to do here beyond the plain read:
     * no per-endpoint overlay step to remember, unlike the old
     * EstimatedPositionCache.overlay() this replaced.
     *
     * Returns LiveMarker, not the full FlightPosition — this is the map's
     * bulk, every-pan-and-zoom fetch, and at a continent or world-sized
     * viewport that's tens of thousands of rows; a client only ever draws a
     * marker from position/heading/identity, never the fuller detail
     * (altitude, velocity, on_ground, ...) that liveOne below returns once
     * an aircraft is actually selected. See LiveMarker's own javadoc.
     */
    @GetMapping("/live")
    public List<LiveMarker> live(@RequestParam(required = false) Double latMin,
                                  @RequestParam(required = false) Double latMax,
                                  @RequestParam(required = false) Double lonMin,
                                  @RequestParam(required = false) Double lonMax) {
        Instant now = Instant.now();
        Instant staleAirborneCutoff = now.minus(LiveVisibilityWindows.STALE_AIRBORNE_BOUND);
        Instant landedCutoff = now.minus(LiveVisibilityWindows.LANDED_VISIBILITY);

        if (latMin == null || latMax == null || lonMin == null || lonMax == null) {
            return liveStateStore.liveMarkers(staleAirborneCutoff, landedCutoff, null);
        }
        Bounds bounds = new Bounds(latMin, latMax, lonMin, lonMax);
        viewportService.report(bounds);
        return liveStateStore.liveMarkers(staleAirborneCutoff, landedCutoff, bounds);
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
        return liveStateStore.countLive(
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
        return liveStateStore.findLatestPosition(icao24)
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
     * Buckets on the same displayLatitude/displayLongitude (estimate-aware)
     * fields every LiveStateStore reader uses — see LiveStateStore.clustered
     * — so a dead-reckoned aircraft lands in the same cell here as its
     * marker would render at once zoomed in past CLUSTER_FETCH_MAX_ZOOM.
     * Clusters count active traffic only (in the air, reported within
     * ACTIVE_TRAFFIC_WINDOW); parked or silent aircraft appear once zoomed in.
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
        return liveStateStore.clustered(
                now.minus(LiveVisibilityWindows.STALE_AIRBORNE_BOUND), now.minus(LiveVisibilityWindows.LANDED_VISIBILITY),
                now.minus(LiveVisibilityWindows.ACTIVE_TRAFFIC_WINDOW),
                bounds, clampedGridDeg);
    }

    private static final int DEFAULT_OVERVIEW_PLANES = 250;
    private static final int MAX_OVERVIEW_PLANES = 1000;
    private static final int DEFAULT_OVERVIEW_PER_CELL = 6;
    private static final int MAX_OVERVIEW_PER_CELL = 20;

    /**
     * The zoomed-out map (below CLUSTER_FETCH_MAX_ZOOM) in one response: the
     * most active aircraft in the viewport, to be drawn as individual planes,
     * plus cluster bubbles for the rest of the active traffic — see
     * LiveStateStore.overview for the ranking and why the two never overlap.
     * Same bbox/gridDeg contract as /live/clusters, and like it deliberately
     * does not touch the reported viewport (a world-sized bbox must not
     * become "the current viewport" for the hot poll and the broadcaster).
     * {@code limit} caps the planes returned, {@code perCell} the planes
     * taken from any one grid cell.
     */
    @GetMapping("/live/overview")
    public LiveOverview liveOverview(@RequestParam double latMin,
                                      @RequestParam double latMax,
                                      @RequestParam double lonMin,
                                      @RequestParam double lonMax,
                                      @RequestParam(defaultValue = "2") double gridDeg,
                                      @RequestParam(defaultValue = "" + DEFAULT_OVERVIEW_PLANES) int limit,
                                      @RequestParam(defaultValue = "" + DEFAULT_OVERVIEW_PER_CELL) int perCell) {
        Instant now = Instant.now();
        Bounds bounds = new Bounds(latMin, latMax, lonMin, lonMax);
        double clampedGridDeg = Math.min(MAX_CLUSTER_GRID_DEG, Math.max(MIN_CLUSTER_GRID_DEG, gridDeg));
        return liveStateStore.overview(
                now.minus(LiveVisibilityWindows.STALE_AIRBORNE_BOUND), now.minus(LiveVisibilityWindows.LANDED_VISIBILITY),
                now.minus(LiveVisibilityWindows.ACTIVE_TRAFFIC_WINDOW),
                bounds, clampedGridDeg,
                Math.min(MAX_OVERVIEW_PLANES, Math.max(0, limit)),
                Math.min(MAX_OVERVIEW_PER_CELL, Math.max(1, perCell)));
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
     * not one merged query). See LiveStateStore.searchByCallsign and
     * searchByAirport below for ranking/matching details.
     *
     * No LIKE-pattern escaping needed any more (a literal `%`/`_`/`\`
     * typed by the user used to need escaping before this reached SQL) —
     * both branches are now plain Java substring/equality matches against
     * the in-memory live set, which handle those characters literally with
     * no special casing.
     */
    @GetMapping("/search")
    public List<FlightPosition> search(@RequestParam(required = false) String q,
                                        @RequestParam(required = false) String airport) {
        Instant now = Instant.now();
        Instant staleAirborneCutoff = now.minus(LiveVisibilityWindows.STALE_AIRBORNE_BOUND);
        Instant landedCutoff = now.minus(LiveVisibilityWindows.LANDED_VISIBILITY);

        String trimmedAirport = airport == null ? "" : airport.trim();
        if (!trimmedAirport.isEmpty()) {
            return searchByAirport(trimmedAirport, staleAirborneCutoff, landedCutoff);
        }

        String trimmed = q == null ? "" : q.trim();
        if (trimmed.isEmpty()) return List.of();
        // Picking a search result flies the map to p.latitude/p.longitude
        // directly (see FlightSearch.tsx) — LiveStateStore already reads
        // EstimatorAgent's current estimate for that, same as every other
        // reader, so it lands on the same best-current-estimate spot the
        // live view will show it at, not a possibly stale fix.
        return liveStateStore.searchByCallsign(trimmed, staleAirborneCutoff, landedCutoff, SEARCH_RESULT_LIMIT);
    }

    /**
     * Backs the "advanced search" panel's single airport field — matches a
     * live aircraft whose origin OR destination airport matches the given
     * pattern (name, IATA code, ICAO code, or city), case-insensitively.
     * The text is resolved to airport codes once (one query over the
     * airport reference table: ICAO/IATA code, name, municipality — so
     * "Kalmar" finds ESMQ), then every live aircraft is matched in memory
     * against its *current* flight's route (AircraftEnrichmentService.
     * knownRoute: by callsign, from CallsignRouteService's cache, which a
     * background job keeps filled for every live callsign). This used to
     * read the per-aircraft route stored on first enrichment — only ever
     * filled for aircraft someone had opened, often a previous leg — and
     * did a reference-table lookup per aircraft. Ordered by callsign
     * ascending (no prefix-match ranking here, unlike searchByCallsign).
     */
    private List<FlightPosition> searchByAirport(String pattern, Instant staleAirborneCutoff, Instant landedCutoff) {
        String needle = pattern.toLowerCase(Locale.ROOT);
        Set<String> matchingCodes = airportRepository.findIcaoCodesMatching(needle);
        List<LiveAircraft> candidates = liveStateStore.liveAircraft(staleAirborneCutoff, landedCutoff);
        if (candidates.isEmpty()) return List.of();

        return candidates.stream()
                .filter(live -> enrichmentService.knownRoute(live.icao24(), live.callsign())
                        .filter(route -> matchesAirport(route, needle, matchingCodes))
                        .isPresent())
                .sorted((a, b) -> compareCallsigns(a.callsign(), b.callsign()))
                .limit(SEARCH_RESULT_LIMIT)
                .map(FlightController::toFlightPosition)
                .toList();
    }

    private static boolean matchesAirport(Route route, String needle, Set<String> matchingCodes) {
        return (route.originAirport() != null && matchingCodes.contains(route.originAirport()))
                || (route.destinationAirport() != null && matchingCodes.contains(route.destinationAirport()))
                || containsIgnoreCase(route.originAirportName(), needle)
                || containsIgnoreCase(route.destinationAirportName(), needle);
    }

    private static boolean containsIgnoreCase(String value, String needle) {
        return value != null && value.toLowerCase(Locale.ROOT).contains(needle);
    }

    private static int compareCallsigns(String a, String b) {
        if (a == null && b == null) return 0;
        if (a == null) return 1;
        if (b == null) return -1;
        return a.compareTo(b);
    }

    private static FlightPosition toFlightPosition(LiveAircraft a) {
        return new FlightPosition(a.id(), a.icao24(), a.callsign(), a.observedAt(),
                a.displayLatitude(), a.displayLongitude(), a.altitudeM(), a.velocityMs(),
                a.headingDeg(), a.verticalRateMs(), a.onGround(), a.agentSource());
    }

    /** Full historic track for one aircraft, for the "trace the route across the map" view. */
    @GetMapping("/{icao24}/history")
    public List<FlightPosition> history(@PathVariable String icao24,
                                         @RequestParam Instant from,
                                         @RequestParam Instant to) {
        return positionRepository.findByIcao24AndObservedAtBetween(icao24, from, to);
    }
}
