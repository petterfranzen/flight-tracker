package com.flighttracker.service.estimator;

import com.flighttracker.model.Aircraft;
import com.flighttracker.model.FlightPosition;
import com.flighttracker.observability.PhaseLogger;
import com.flighttracker.repository.AircraftRepository;
import com.flighttracker.service.EstimatedPositionService;
import com.flighttracker.service.LiveVisibilityWindows;
import com.flighttracker.service.live.LiveStateStore;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Function;
import java.util.stream.Collectors;

/**
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

    private final LiveStateStore liveStateStore;
    private final AircraftRepository aircraftRepository;
    private final PhaseLogger phases;

    public EstimatorAgent(LiveStateStore liveStateStore,
                           AircraftRepository aircraftRepository,
                           PhaseLogger phases) {
        this.liveStateStore = liveStateStore;
        this.aircraftRepository = aircraftRepository;
        this.phases = phases;
    }

    @Scheduled(fixedDelayString = "#{${flighttracker.estimator.refresh-interval-seconds} * 1000}")
    void refresh() {
        Instant now = Instant.now();
        List<FlightPosition> live = liveStateStore.liveFlightPositions(
                now.minus(LiveVisibilityWindows.STALE_AIRBORNE_BOUND),
                now.minus(LiveVisibilityWindows.LANDED_VISIBILITY),
                null);

        if (live.isEmpty()) {
            phases.idle("no live aircraft to estimate");
            return;
        }
        // This loop runs every few seconds, which is exactly the shape
        // that would spam the log — PhaseLogger only emits on transition,
        // so in practice this prints once when estimating starts and not
        // again until it stops.
        phases.populating("refreshing estimated positions");

        // One batched lookup for every aircraft in this cycle rather than a
        // query each — EstimatedPositionService needs each one's filed
        // destination, which FlightPosition itself doesn't carry.
        List<String> icao24s = live.stream().map(FlightPosition::getIcao24).distinct().toList();
        Map<String, Aircraft> byIcao24 = aircraftRepository.findAllById(icao24s).stream()
                .collect(Collectors.toMap(Aircraft::getIcao24, Function.identity()));
        Set<String> alreadyEstimated = liveStateStore.icao24sWithEstimate();

        int written = 0;
        for (FlightPosition p : live) {
            Aircraft a = byIcao24.get(p.getIcao24());
            Double destLat = a == null ? null : a.getDestinationAirportLat();
            Double destLon = a == null ? null : a.getDestinationAirportLon();

            // estimate() returns the exact same reference `p` when it
            // decided not to project (on ground, no destination, too
            // slow, too recent) and a new object only when it actually
            // did — cheap, correct way to tell which happened without
            // re-deriving the eligibility rules here.
            FlightPosition estimated = EstimatedPositionService.estimate(p, now, destLat, destLon);
            boolean projected = estimated != p;
            if (!projected && !alreadyEstimated.contains(p.getIcao24())) continue; // null over already-null: nothing to do

            boolean applied = liveStateStore.writeEstimate(p.getIcao24(), p.getObservedAt(),
                    projected ? estimated.getLatitude() : null,
                    projected ? estimated.getLongitude() : null,
                    projected ? now : null);
            if (applied) written++;
        }

        log.debug("estimated positions for {} of {} live aircraft ({} unchanged, skipped)",
                written, live.size(), live.size() - written);
    }
}
