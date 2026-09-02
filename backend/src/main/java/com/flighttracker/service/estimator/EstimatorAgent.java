package com.flighttracker.service.estimator;

import com.flighttracker.model.Aircraft;
import com.flighttracker.model.FlightPosition;
import com.flighttracker.repository.AircraftRepository;
import com.flighttracker.repository.FlightPositionRepository;
import com.flighttracker.service.EstimatedPositionService;
import com.flighttracker.service.LiveVisibilityWindows;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.annotation.Profile;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.sql.PreparedStatement;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.sql.Types;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Function;
import java.util.stream.Collectors;

/**
 * Keeps aircraft_latest_position's estimated_latitude/estimated_longitude/
 * estimated_at columns up to date — "filling in" a dead-reckoned current
 * position for every live aircraft, the same math EstimatedPositionCache
 * used to do (see EstimatedPositionService, unchanged), but persisted into
 * the database instead of held in an in-process cache. This is what lets
 * every reader (FlightController's /live, /search, /live/clusters, and
 * AircraftController's dossier) see the same current-best-position without
 * any of them needing their own read-time overlay step — that used to be
 * applied by some endpoints and not others, which is exactly how the map's
 * clustered and individual views could end up disagreeing about what's
 * currently visible.
 *
 * Runs in its own container (@Profile("estimator"), see docker-compose.yml's
 * backend-estimator service) — same split as "api" vs "agent", just a third
 * profile on the same image. Must never run alongside "agent" in the same
 * process: both would schedule their own independent work against the same
 * DB rows, which is harmless for correctness (see below) but doubles the
 * write load for no benefit.
 *
 * Every cycle, for every aircraft findLive() currently considers live —
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
 * entirely when the row's estimated_latitude is already NULL (see
 * FlightPositionRepository.findIcao24sWithEstimate()), since writing NULL
 * over NULL changes nothing. This matters because estimated_latitude/
 * estimated_longitude feed idx_latest_position_bbox_estimated, so every
 * write here — even a no-op one — is a full B-tree index update, not
 * just a heap write; at any moment most of the live set is ineligible
 * (grounded, no filed destination, too slow) and already has no estimate,
 * so without this check every cycle rewrote that majority for nothing.
 * Confirmed as the dominant contributor to real write amplification
 * observed on the production deployment (459GB written against ~1GB of
 * actual table data). A genuine projection, or clearing a stale non-NULL
 * estimate, is never skipped - only a NULL-over-already-NULL write is.
 *
 * Each row's UPDATE is guarded by {@code WHERE icao24 = ? AND observed_at
 * = ?}, binding the exact observed_at this cycle's findLive() read for
 * that aircraft — an optimistic-concurrency check against the live agent's
 * own writes. Without it: this cycle reads a stale position, a real report
 * lands (and, per FlightPositionRepository.upsertLatestPosition, clears
 * any estimate) before this cycle's UPDATE runs, and that UPDATE would
 * silently clobber the fresh real-report state with a stale projection
 * computed from data that's already been superseded. With the guard, that
 * UPDATE simply matches zero rows — a correct no-op; the next cycle reads
 * the now-current data and estimates from that instead. No table lock or
 * SELECT ... FOR UPDATE needed: Postgres's own row-level MVCC is enough
 * once the two writers (this class and the live agent) only ever touch
 * disjoint sets of columns on the same row.
 */
@Service
@Profile("estimator")
public class EstimatorAgent {

    private static final Logger log = LoggerFactory.getLogger(EstimatorAgent.class);

    // Rows per PreparedStatement.executeBatch() call — same reasoning and
    // same value as PositionPersistenceService.JDBC_BATCH_SIZE (a separate
    // constant since this is a different class/profile, not because the
    // number should ever differ).
    private static final int JDBC_BATCH_SIZE = 1000;

    private static final String ESTIMATE_UPDATE_SQL = """
        UPDATE aircraft_latest_position
        SET estimated_latitude = ?, estimated_longitude = ?, estimated_at = ?
        WHERE icao24 = ? AND observed_at = ?
        """;

    private final FlightPositionRepository positionRepository;
    private final AircraftRepository aircraftRepository;
    private final JdbcTemplate jdbcTemplate;

    public EstimatorAgent(FlightPositionRepository positionRepository,
                           AircraftRepository aircraftRepository,
                           JdbcTemplate jdbcTemplate) {
        this.positionRepository = positionRepository;
        this.aircraftRepository = aircraftRepository;
        this.jdbcTemplate = jdbcTemplate;
    }

    @Scheduled(fixedDelayString = "#{${flighttracker.estimator.refresh-interval-seconds} * 1000}")
    @Transactional
    void refresh() {
        Instant now = Instant.now();
        List<FlightPosition> live = positionRepository.findLive(
                now.minus(LiveVisibilityWindows.STALE_AIRBORNE_BOUND),
                now.minus(LiveVisibilityWindows.LANDED_VISIBILITY));

        if (live.isEmpty()) return;

        // One batched lookup for every aircraft in this cycle rather than a
        // query each — EstimatedPositionService needs each one's filed
        // destination, which FlightPosition itself doesn't carry.
        List<String> icao24s = live.stream().map(FlightPosition::getIcao24).distinct().toList();
        Map<String, Aircraft> byIcao24 = aircraftRepository.findAllById(icao24s).stream()
                .collect(Collectors.toMap(Aircraft::getIcao24, Function.identity()));
        Set<String> alreadyEstimated = positionRepository.findIcao24sWithEstimate();

        // Decided upfront, not inside the PreparedStatementSetter below —
        // batchUpdate binds every item in the list it's given, so skipping
        // a row means never adding it here, not skipping some binding step.
        List<PendingEstimate> toWrite = new ArrayList<>(live.size());
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
            if (!projected && !alreadyEstimated.contains(p.getIcao24())) continue; // NULL over already-NULL: nothing to do
            toWrite.add(new PendingEstimate(p, projected ? estimated : null));
        }
        if (toWrite.isEmpty()) return;

        jdbcTemplate.batchUpdate(ESTIMATE_UPDATE_SQL, toWrite, JDBC_BATCH_SIZE,
                (PreparedStatement ps, PendingEstimate pe) -> bindEstimateUpdate(ps, pe, now));

        log.debug("estimated positions for {} of {} live aircraft ({} unchanged, skipped)",
                toWrite.size(), live.size(), live.size() - toWrite.size());
    }

    /** estimated is null when this cycle resolved to "clear to NULL" (a real write, unlike the already-NULL case skipped above). */
    private record PendingEstimate(FlightPosition original, FlightPosition estimated) {
    }

    private static void bindEstimateUpdate(PreparedStatement ps, PendingEstimate pe, Instant now) throws SQLException {
        FlightPosition p = pe.original();
        if (pe.estimated() != null) {
            ps.setDouble(1, pe.estimated().getLatitude());
            ps.setDouble(2, pe.estimated().getLongitude());
            ps.setTimestamp(3, Timestamp.from(now));
        } else {
            ps.setNull(1, Types.DOUBLE);
            ps.setNull(2, Types.DOUBLE);
            ps.setNull(3, Types.TIMESTAMP);
        }
        ps.setString(4, p.getIcao24());
        ps.setTimestamp(5, Timestamp.from(p.getObservedAt()));
    }
}
