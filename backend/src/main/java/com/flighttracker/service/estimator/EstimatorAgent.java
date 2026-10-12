package com.flighttracker.service.estimator;

import com.flighttracker.model.FlightPosition;
import com.flighttracker.observability.PhaseLogger;
import com.flighttracker.repository.FlightPositionRepository;
import com.flighttracker.service.EstimatedPositionService;
import com.flighttracker.service.LiveVisibilityWindows;
import com.flighttracker.service.coverage.CoverageGapEstimator;
import com.flighttracker.service.coverage.GapEstimate;
import com.flighttracker.service.coverage.GapInput;
import com.flighttracker.service.coverage.PollCoverageTracker;
import com.flighttracker.service.coverage.RunwayIndex;
import com.flighttracker.service.coverage.TrackPoint;
import com.flighttracker.service.enrichment.CallsignRouteService;
import com.flighttracker.service.enrichment.Route;
import com.flighttracker.service.live.LiveAircraft;
import com.flighttracker.service.live.LiveStateStore;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Two kinds of estimate, both written into LiveStateStore.
 *
 * <p>Aircraft in a coverage gap (a poll that covered their last position
 * completed well after their last report, see PollCoverageTracker) get a
 * CoverageGapEstimator answer, stored as LiveAircraft.gap: where the plane
 * probably is, how sure we are, and whether it has probably landed. Its
 * inputs (the last ~10 minutes of reports) don't change while the aircraft
 * stays silent, so they are read from flight_position once per
 * (icao24, observedAt) and cached, with a cap on new reads per tick.
 *
 * <p>Every other airborne aircraft keeps the between-sweep dead reckoning
 * described below, towards the destination of its callsign route.
 *
 * Keeps LiveStateStore's estimatedLatitude/estimatedLongitude/estimatedAt
 * fields up to date — "filling in" a dead-reckoned current position for
 * every live aircraft, the same math EstimatedPositionCache used to do
 * (see EstimatedPositionService, unchanged), now written straight into the
 * in-process live-state map instead of a database column (cloud migration
 * A1 — see LiveStateStore's own javadoc for why aircraft_latest_position
 * moved into memory). This is what lets every reader (FlightController's
 * /live, /search, /live/clusters, and AircraftController's dossier) see
 * the same current-best-position without any of them needing their own
 * read-time overlay step — that used to be applied by some endpoints and
 * not others, which is exactly how the map's clustered and individual
 * views could end up disagreeing about what's currently visible.
 *
 * Runs as one more @Scheduled method in the single consolidated process
 * (see FlightTrackerApplication) — no longer its own container/profile.
 *
 * Every cycle, for every aircraft LiveStateStore currently considers live —
 * not just ones that were eligible for an estimate last cycle — this
 * considers writing either a freshly-projected estimate or an explicit
 * NULL triple (when EstimatedPositionService.estimate() didn't change
 * anything: on ground, no destination, too slow, too recent). Stateless
 * by design: no cross-cycle bookkeeping of "who was eligible before" is
 * needed, and an aircraft that quietly becomes ineligible without ever
 * leaving the live window (e.g. its destination gets cleared by
 * re-enrichment) still gets its stale estimate cleared on the very next
 * cycle, not left stuck forever.
 *
 * "Considers" - not "always does": a NULL-triple write is skipped
 * entirely when the aircraft's estimatedLatitude is already null (see
 * LiveStateStore.icao24sWithEstimate()), since writing null over null
 * changes nothing. This mattered a great deal when this lived in Postgres
 * — estimated_latitude/estimated_longitude fed idx_latest_position_bbox_estimated,
 * so every write was a full B-tree index update, not just a heap write,
 * and was confirmed as the dominant contributor to real write
 * amplification observed on the production deployment (459GB written
 * against ~1GB of actual table data). There's no index to maintain now
 * that this is an in-memory map — a skipped write here just saves
 * allocating and swapping in an unchanged LiveAircraft record — but the
 * check is kept: it's still free correctness (no observable difference
 * either way) and the reasoning above is worth keeping visible for
 * whoever next touches this. A genuine projection, or clearing a stale
 * non-null estimate, is never skipped - only a null-over-already-null
 * write is.
 *
 * Each aircraft's write is guarded by LiveStateStore.writeEstimate's own
 * {@code observedAt} check — an optimistic-concurrency guard against the
 * live agent's own writes, ported unchanged from the original SQL's
 * {@code WHERE icao24 = ? AND observed_at = ?}. Without it: this cycle
 * reads a stale position, a real report lands (and, per
 * LiveStateStore.upsert, clears any estimate) before this cycle's write
 * runs, and that write would silently clobber the fresh real-report state
 * with a stale projection computed from data that's already been
 * superseded. With the guard, that write simply no-ops; the next cycle
 * reads the now-current data and estimates from that instead.
 */
@Service
public class EstimatorAgent {

    private static final Logger log = LoggerFactory.getLogger(EstimatorAgent.class);

    /** The reports a gap estimate is computed from, fixed while the aircraft stays silent. */
    private record Snapshot(Instant observedAt, List<TrackPoint> recent) { }

    private final LiveStateStore liveStateStore;
    private final PhaseLogger phases;
    private final Clock clock;
    private final PollCoverageTracker coverageTracker;
    private final FlightPositionRepository positionRepository;
    private final RunwayIndex runwayIndex;
    private final CoverageGapEstimator gapEstimator;
    private final CallsignRouteService routeService;
    private final Duration gapGrace;
    private final Duration snapshotWindow;
    private final int maxSnapshotLoadsPerTick;
    private final double runwayRadiusM;

    private final Map<String, Snapshot> snapshots = new ConcurrentHashMap<>();

    public EstimatorAgent(LiveStateStore liveStateStore,
                           PhaseLogger phases,
                           Clock clock,
                           PollCoverageTracker coverageTracker,
                           FlightPositionRepository positionRepository,
                           RunwayIndex runwayIndex,
                           CoverageGapEstimator gapEstimator,
                           CallsignRouteService routeService,
                           @Value("${flighttracker.coverage.gap-grace-seconds:60}") long gapGraceSeconds,
                           @Value("${flighttracker.coverage.snapshot-minutes:10}") long snapshotMinutes,
                           @Value("${flighttracker.coverage.max-snapshot-loads-per-tick:300}") int maxSnapshotLoadsPerTick,
                           @Value("${flighttracker.coverage.runway-radius-km:50}") double runwayRadiusKm) {
        this.liveStateStore = liveStateStore;
        this.phases = phases;
        this.clock = clock;
        this.coverageTracker = coverageTracker;
        this.positionRepository = positionRepository;
        this.runwayIndex = runwayIndex;
        this.gapEstimator = gapEstimator;
        this.routeService = routeService;
        this.gapGrace = Duration.ofSeconds(gapGraceSeconds);
        this.snapshotWindow = Duration.ofMinutes(snapshotMinutes);
        this.maxSnapshotLoadsPerTick = maxSnapshotLoadsPerTick;
        this.runwayRadiusM = runwayRadiusKm * 1000;
    }

    @Scheduled(fixedDelayString = "#{${flighttracker.estimator.refresh-interval-seconds} * 1000}")
    void refresh() {
        Instant now = clock.instant();
        List<LiveAircraft> live = liveStateStore.liveAircraft(
                now.minus(LiveVisibilityWindows.STALE_AIRBORNE_BOUND),
                now.minus(LiveVisibilityWindows.LANDED_VISIBILITY));

        if (live.isEmpty()) {
            snapshots.clear();
            phases.idle("no live aircraft to estimate");
            return;
        }
        // This loop runs every few seconds, which is exactly the shape
        // that would spam the log — PhaseLogger only emits on transition,
        // so in practice this prints once when estimating starts and not
        // again until it stops.
        phases.populating("refreshing estimated positions");

        Set<String> alreadyEstimated = liveStateStore.icao24sWithEstimate();
        Set<String> inGap = new HashSet<>();
        int snapshotLoads = 0;

        int written = 0;
        int gapWritten = 0;
        int failed = 0;
        String firstFailure = null;
        for (LiveAircraft a : live) {
            try {
                Optional<Route> route = routeService.cached(a.callsign());
                Double destLat = route.map(Route::destinationAirportLat).orElse(null);
                Double destLon = route.map(Route::destinationAirportLon).orElse(null);

                if (isInGap(a)) {
                    inGap.add(a.icao24());
                    Snapshot snap = snapshots.get(a.icao24());
                    if (snap == null || !snap.observedAt().equals(a.observedAt())) {
                        if (snapshotLoads >= maxSnapshotLoadsPerTick) continue; // next tick; keeps what it shows now
                        snapshotLoads++;
                        snap = loadSnapshot(a);
                        snapshots.put(a.icao24(), snap);
                    }
                    GapEstimate gap = gapEstimator.estimate(new GapInput(
                            snap.recent(),
                            runwayIndex.near(a.latitude(), a.longitude(), runwayRadiusM),
                            route.map(Route::destinationAirport).orElse(null),
                            destLat, destLon, now));
                    if (liveStateStore.writeGapEstimate(a.icao24(), a.observedAt(), gap)) {
                        written++;
                        gapWritten++;
                    }
                    continue;
                }

                // The raw last report, not the display position: that may
                // already be last cycle's estimate, and projecting from it
                // would count the elapsed time twice.
                FlightPosition p = new FlightPosition(a.icao24(), a.callsign(), a.observedAt(),
                        a.latitude(), a.longitude(), a.altitudeM(), a.velocityMs(), a.headingDeg(),
                        a.verticalRateMs(), a.onGround(), a.agentSource());
                // estimate() returns the exact same reference `p` when it
                // decided not to project (on ground, no destination, too
                // slow, too recent) and a new object only when it actually
                // did — cheap, correct way to tell which happened without
                // re-deriving the eligibility rules here.
                FlightPosition estimated = EstimatedPositionService.estimate(p, now, destLat, destLon);
                boolean projected = estimated != p;
                if (!projected && !alreadyEstimated.contains(a.icao24())) continue; // null over already-null: nothing to do

                boolean applied = liveStateStore.writeEstimate(a.icao24(), a.observedAt(),
                        projected ? estimated.latitude() : null,
                        projected ? estimated.longitude() : null,
                        projected ? now : null);
                if (applied) written++;
            } catch (RuntimeException e) {
                // One summary line per tick below; the stack of each stays at debug.
                if (failed++ == 0) firstFailure = a.icao24() + ": " + e;
                log.debug("Estimating {} failed this cycle", a.icao24(), e);
            }
        }
        if (failed > 0) {
            log.warn("Estimating failed for {} of {} live aircraft this cycle; first: {}",
                    failed, live.size(), firstFailure);
        }
        snapshots.keySet().retainAll(inGap); // no longer in a gap, or evicted

        log.debug("estimated positions for {} of {} live aircraft ({} in a coverage gap, {} snapshot loads)",
                written, live.size(), gapWritten, snapshotLoads);
    }

    /** Airborne, and a poll that covered its last position finished well after its last report. */
    private boolean isInGap(LiveAircraft a) {
        if (a.onGround()) return false;
        return coverageTracker.lastCoveringPollAt(a.latitude(), a.longitude())
                .filter(polledAt -> polledAt.isAfter(a.observedAt().plus(gapGrace)))
                .isPresent();
    }

    /** The snapshot window of reports before the last one, oldest first, ending with the last report itself. */
    private Snapshot loadSnapshot(LiveAircraft a) {
        List<TrackPoint> recent = new ArrayList<>();
        Instant previous = null;
        for (FlightPosition p : positionRepository.findByIcao24AndObservedAtBetween(
                a.icao24(), a.observedAt().minus(snapshotWindow), a.observedAt())) {
            // Two sources can report the same instant; the live report itself is appended below.
            if (!p.observedAt().isBefore(a.observedAt()) || p.observedAt().equals(previous)) continue;
            previous = p.observedAt();
            recent.add(new TrackPoint(p.observedAt(), p.latitude(), p.longitude(), p.altitudeM(),
                    p.velocityMs(), p.headingDeg(), p.verticalRateMs(), p.onGround()));
        }
        recent.add(new TrackPoint(a.observedAt(), a.latitude(), a.longitude(), a.altitudeM(),
                a.velocityMs(), a.headingDeg(), a.verticalRateMs(), a.onGround()));
        return new Snapshot(a.observedAt(), List.copyOf(recent));
    }
}
