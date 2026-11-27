package com.flighttracker.controller;

import com.flighttracker.dto.Bounds;
import com.flighttracker.dto.ClusterPoint;
import com.flighttracker.dto.LiveMarker;
import com.flighttracker.dto.LiveOverview;
import com.flighttracker.dto.TrackStatus;
import com.flighttracker.model.FlightPosition;
import com.flighttracker.repository.FlightPositionRepository;
import com.flighttracker.service.LiveVisibilityWindows;
import com.flighttracker.service.ViewportService;
import com.flighttracker.service.confirmation.ConfirmationStore;
import com.flighttracker.service.live.ActiveTrafficQuery;
import com.flighttracker.service.live.LiveFlightSearch;
import com.flighttracker.service.live.LiveStateStore;
import com.flighttracker.service.live.PlaneAllowance;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.time.Instant;
import java.util.List;
import java.util.Locale;

@RestController
@RequestMapping("/api/flights")
public class FlightController {

    private final LiveStateStore liveStateStore;
    private final FlightPositionRepository positionRepository;
    private final ViewportService viewportService;
    private final ConfirmationStore confirmationStore;
    private final LiveFlightSearch flightSearch;

    public FlightController(LiveStateStore liveStateStore,
                             FlightPositionRepository positionRepository,
                             ViewportService viewportService,
                             ConfirmationStore confirmationStore,
                             LiveFlightSearch flightSearch) {
        this.liveStateStore = liveStateStore;
        this.positionRepository = positionRepository;
        this.viewportService = viewportService;
        this.confirmationStore = confirmationStore;
        this.flightSearch = flightSearch;
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
    public List<LiveMarker> live(@QueryParams ViewportParams viewport) {
        Cutoffs c = Cutoffs.at(Instant.now());
        Bounds bounds = viewport.bounds().orElse(null);
        if (bounds != null) viewportService.report(bounds);
        return liveStateStore.liveMarkers(c.staleAirborne(), c.landed(), bounds);
    }

    /**
     * Global counterpart to /live's own bbox-less form, minus the cost of
     * fetching every row just to measure how many there are — the map's
     * "TRACKED" chip wants a worldwide total regardless of the current
     * viewport, refreshed alongside every /live poll, so this stays a
     * plain count rather than reusing the bbox-less list endpoint.
     */
    @GetMapping("/live/count")
    public long liveCount(@RequestParam(defaultValue = "false") boolean active) {
        Cutoffs c = Cutoffs.at(Instant.now());
        // active=true: only aircraft in the air that reported within
        // ACTIVE_TRAFFIC_WINDOW (what the map's "ACTIVE" chip shows), not
        // everything still remembered.
        if (active) return liveStateStore.countActive(c.active());
        return liveStateStore.countLive(c.staleAirborne(), c.landed());
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
        icao24 = normalizeIcao24(icao24);
        return liveStateStore.findLatestPosition(icao24)
                .map(ResponseEntity::ok)
                .orElseGet(() -> ResponseEntity.notFound().build());
    }

    /**
     * Coverage-gap state of one aircraft: observed (live or on the ground)
     * or, while it has gone silent, the estimator's inferred position and
     * landing call, or a provider's confirmation (landed, at the gate). Same lookup as liveOne, so 404 means the same thing:
     * the live set has no such aircraft.
     */
    @GetMapping("/{icao24}/status")
    public ResponseEntity<TrackStatus> status(@PathVariable String icao24) {
        icao24 = normalizeIcao24(icao24);
        return liveStateStore.get(icao24)
                .map(a -> ResponseEntity.ok(TrackStatus.from(a, confirmationStore.forAircraft(a))))
                .orElseGet(() -> ResponseEntity.notFound().build());
    }

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
    public List<ClusterPoint> liveClusters(@QueryParams BboxParams bbox,
                                            @RequestParam(defaultValue = "2") double gridDeg) {
        Cutoffs c = Cutoffs.at(Instant.now());
        return liveStateStore.clustered(c.in(bbox.bounds()), ClusterGrid.clamp(gridDeg));
    }

    /**
     * The zoomed-out map (below CLUSTER_FETCH_MAX_ZOOM) in one response: the
     * most active aircraft in the viewport, to be drawn as individual planes,
     * plus cluster bubbles for the rest of the active traffic — see
     * LiveStateStore.overview for the ranking and why the two never overlap.
     * Same bbox/gridDeg contract as /live/clusters, and like it deliberately
     * does not touch the reported viewport (a world-sized bbox must not
     * become "the current viewport" for the hot poll and the broadcaster).
     * {@code limit} caps the planes returned, {@code perCell} the planes
     * taken from any one grid cell. With {@code declutter=true} it is the
     * cluster-free variant instead: one plane per cell, first discovered
     * wins, no clusters (see LiveStateStore.discovered).
     */
    @GetMapping("/live/overview")
    public LiveOverview liveOverview(@QueryParams BboxParams bbox, @QueryParams OverviewParams view) {
        ActiveTrafficQuery query = Cutoffs.at(Instant.now()).in(bbox.bounds());
        PlaneAllowance allowance = view.allowance();
        if (view.declutter()) {
            // No clusters: one plane per cell, first discovered wins (see LiveStateStore.discovered).
            return liveStateStore.discovered(query, allowance.gridDeg(), allowance.maxPlanes());
        }
        return liveStateStore.overview(query, allowance);
    }

    /** The visibility cutoffs every endpoint here reads, all relative to one {@code now}. */
    private record Cutoffs(Instant staleAirborne, Instant landed, Instant active) {
        static Cutoffs at(Instant now) {
            return new Cutoffs(now.minus(LiveVisibilityWindows.STALE_AIRBORNE_BOUND),
                    now.minus(LiveVisibilityWindows.LANDED_VISIBILITY),
                    now.minus(LiveVisibilityWindows.ACTIVE_TRAFFIC_WINDOW));
        }

        ActiveTrafficQuery in(Bounds bounds) {
            return new ActiveTrafficQuery(staleAirborne, landed, active, bounds);
        }
    }

    /**
     * Search-box autocomplete: live aircraft whose callsign matches `q`,
     * for "type a flight number, zoom to the plane" (see FlightSearch.tsx).
     * `airport` backs the separate "advanced search" panel's single
     * airport field instead — matches an aircraft whose origin OR
     * destination airport matches (name, IATA code, ICAO code, or city);
     * when given, it takes over from `q` entirely rather than combining
     * with it (the two are presented as distinct search modes in the UI,
     * not one merged query). See LiveFlightSearch.byCallsign and
     * byAirport for ranking/matching details.
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
        Cutoffs c = Cutoffs.at(Instant.now());
        String trimmedAirport = trimToEmpty(airport);
        if (!trimmedAirport.isEmpty()) {
            return flightSearch.byAirport(trimmedAirport, c.staleAirborne(), c.landed());
        }

        String trimmed = trimToEmpty(q);
        if (trimmed.isEmpty()) return List.of();
        // Picking a search result flies the map to p.latitude/p.longitude
        // directly (see FlightSearch.tsx) — LiveStateStore already reads
        // EstimatorAgent's current estimate for that, same as every other
        // reader, so it lands on the same best-current-estimate spot the
        // live view will show it at, not a possibly stale fix.
        return flightSearch.byCallsign(trimmed, c.staleAirborne(), c.landed());
    }

    private static String trimToEmpty(String value) {
        return value == null ? "" : value.trim();
    }

    /** Full historic track for one aircraft, for the "trace the route across the map" view. */
    @GetMapping("/{icao24}/history")
    public List<FlightPosition> history(@PathVariable String icao24,
                                         @RequestParam Instant from,
                                         @RequestParam Instant to) {
        return positionRepository.findByIcao24AndObservedAtBetween(normalizeIcao24(icao24), from, to);
    }

    // icao24 is stored lower case; a mixed-case URL must still find it.
    private static String normalizeIcao24(String icao24) {
        return icao24.trim().toLowerCase(Locale.ROOT);
    }
}
