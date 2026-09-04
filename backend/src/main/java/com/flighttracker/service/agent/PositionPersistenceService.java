package com.flighttracker.service.agent;

import com.flighttracker.model.Aircraft;
import com.flighttracker.repository.AircraftRepository;
import com.flighttracker.repository.FlightPositionRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.annotation.Profile;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.sql.PreparedStatement;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.sql.Types;
import java.util.ArrayList;
import java.util.List;

/**
 * A separate bean from AgentOrchestrator specifically so persist() is
 * called across a real proxy boundary — @Transactional (and any other
 * Spring AOP advice) is applied via a dynamic proxy wrapping the bean, and
 * only takes effect on calls that go *through* that proxy. A same-class
 * self-invocation (AgentOrchestrator calling its own persist() method via
 * implicit `this`) bypasses the proxy entirely and silently runs with no
 * transaction — which worked by accident for the plain RETURNING-based
 * insert below, but broke loudly the moment upsertLatestPosition's
 * @Modifying executeUpdate() (which the JPA spec requires an active
 * transaction for) was added. This class exists so AgentOrchestrator has
 * to call persist() as a normal injected-bean call instead.
 *
 * Two write paths, chosen by batch size: persist() (Spring Data, one row
 * at a time, up to 4 DB round-trips per report) for the hot poll's small
 * batches (~15-50 reports), and persistBatch() (raw JdbcTemplate, batched
 * multi-row statements) for the global sweep's much larger ones (~13k
 * worldwide reports) — see persistBatch's own javadoc for why the
 * per-report approach that's fine at hot-poll scale measured taking ~14
 * minutes at sweep scale, blocking everything else sharing this process's
 * scheduler for that whole time (see spring.task.scheduling.pool.size in
 * application.yml for the other half of that fix).
 */
@Service
@Profile("agent")
public class PositionPersistenceService {

    private static final Logger log = LoggerFactory.getLogger(PositionPersistenceService.class);
    private static final String POSITION_NOTIFY_CHANNEL = "flight_position";

    private final AircraftRepository aircraftRepository;
    private final FlightPositionRepository positionRepository;
    private final JdbcTemplate jdbcTemplate;

    public PositionPersistenceService(AircraftRepository aircraftRepository,
                                       FlightPositionRepository positionRepository,
                                       JdbcTemplate jdbcTemplate) {
        this.aircraftRepository = aircraftRepository;
        this.positionRepository = positionRepository;
        this.jdbcTemplate = jdbcTemplate;
    }

    /** True only on a genuinely fresh database — see AgentOrchestrator.seedOnStartup. */
    public boolean hasNoPositions() {
        return positionRepository.countLatestPositions() == 0;
    }

    /** Returns the reports for icao24s that were newly seen this cycle (not already known aircraft). */
    @Transactional
    public List<RawPositionReport> persist(String sourceName, List<RawPositionReport> reports) {
        int written = 0;
        List<RawPositionReport> newAircraft = new ArrayList<>();
        for (RawPositionReport r : reports) {
            // existsById, not findById: this only needs to know whether the
            // aircraft is new, and loading the entity used to exist purely
            // to call touch() on it — which bumped last_seen_at, a column
            // nothing reads (see AIRCRAFT_UPSERT_SQL). Loading it into the
            // persistence context also meant Hibernate's dirty check
            // emitted an UPDATE per known aircraft on every flush.
            if (!aircraftRepository.existsById(r.icao24())) {
                aircraftRepository.save(new Aircraft(r.icao24()));
                newAircraft.add(r);
            }
            var inserted = positionRepository.insertIgnoringDuplicate(
                    r.icao24(), r.callsign(), r.observedAt(),
                    r.latitude(), r.longitude(), r.altitudeM(),
                    r.velocityMs(), r.headingDeg(), r.verticalRateMs(),
                    r.onGround(), sourceName);
            if (inserted.isPresent()) {
                // Keeps the "latest per aircraft" summary table (see its
                // schema.sql comment) in step with the append-only history —
                // every accepted report updates both, in the same transaction.
                positionRepository.upsertLatestPosition(
                        r.icao24(), r.callsign(), r.observedAt(),
                        r.latitude(), r.longitude(), r.altitudeM(),
                        r.velocityMs(), r.headingDeg(), r.verticalRateMs(),
                        r.onGround(), sourceName);
                // The "api" container's WebSocket clients live in a separate
                // process now, so there's no LiveFeedBroadcaster to call
                // directly here — NOTIFY instead (see
                // PositionNotificationListener on the api side). Postgres
                // only delivers this to LISTENers once *this* transaction
                // commits, and only the row id is sent (LISTEN/NOTIFY has an
                // 8000-byte payload cap, and the listener can cheaply look
                // the row up itself).
                jdbcTemplate.execute("NOTIFY " + POSITION_NOTIFY_CHANNEL + ", '" + inserted.get().getId() + "'");
                written++;
            }
            // else: another agent already reported this exact (icao24, observed_at) tick — expected, skip
        }
        log.info("{}: wrote {} of {} position reports", sourceName, written, reports.size());
        return newAircraft;
    }

    // Rows per PreparedStatement.executeBatch() call — JdbcTemplate.
    // batchUpdate's own batchSize overload chunks a full reports list into
    // calls this size automatically. Bounds how many bound parameters (and
    // how much driver-side buffering) any single round-trip needs, rather
    // than sending one ~13k-row batch as a single call — 1000 is
    // comfortably small for that and comfortably large to keep round-trips
    // down (~13 calls per statement type for a full sweep, vs. one per row).
    private static final int JDBC_BATCH_SIZE = 1000;

    // Same insert-if-absent persist()'s aircraftRepository lookup/save pair
    // does, collapsed into one statement. Unlike persist(), this doesn't
    // need to know which icao24s were new — see persistBatch's javadoc.
    //
    // DO NOTHING, not the DO UPDATE SET last_seen_at = now() this used to
    // be. That bump ran for every distinct icao24 in every sweep — ~2.76M
    // updates/day against a ~22k-row table, turning it over ~125 times a
    // day — and nothing anywhere read the column: no query, endpoint or
    // DTO in the backend, nothing in the frontend, only the entity's own
    // unused getter. Three quarters of those updates weren't even HOT, so
    // each one rewrote index entries too. Pure write amplification for no
    // reader, which on a NAS is the expensive kind of nothing.
    private static final String AIRCRAFT_UPSERT_SQL = """
        INSERT INTO aircraft (icao24, first_seen_at, last_seen_at)
        VALUES (?, now(), now())
        ON CONFLICT (icao24) DO NOTHING
        """;

    // Same statement as FlightPositionRepository.insertIgnoringDuplicate,
    // positional params instead of named ones for raw JdbcTemplate use.
    private static final String POSITION_INSERT_SQL = """
        INSERT INTO flight_position
            (icao24, callsign, observed_at, latitude, longitude, altitude_m,
             velocity_ms, heading_deg, vertical_rate_ms, on_ground, agent_source)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (icao24, observed_at, agent_source) DO NOTHING
        """;

    // Same statement as FlightPositionRepository.upsertLatestPosition —
    // on_ground and observed_at are each bound twice (params 10/12 and
    // 3/13) because the landed_since CASE needs both again, same as the
    // named-parameter version reusing :onGround/:observedAt twice.
    // estimated_latitude/longitude/at are unconditionally cleared to NULL
    // for the same reason as the named-parameter version — see that
    // query's comment.
    private static final String LATEST_POSITION_UPSERT_SQL = """
        INSERT INTO aircraft_latest_position
            (icao24, callsign, observed_at, latitude, longitude, altitude_m,
             velocity_ms, heading_deg, vertical_rate_ms, on_ground, agent_source, landed_since)
        VALUES
            (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? THEN CAST(? AS timestamptz) ELSE NULL END)
        ON CONFLICT (icao24) DO UPDATE SET
            callsign = EXCLUDED.callsign,
            observed_at = EXCLUDED.observed_at,
            latitude = EXCLUDED.latitude,
            longitude = EXCLUDED.longitude,
            altitude_m = EXCLUDED.altitude_m,
            velocity_ms = EXCLUDED.velocity_ms,
            heading_deg = EXCLUDED.heading_deg,
            vertical_rate_ms = EXCLUDED.vertical_rate_ms,
            on_ground = EXCLUDED.on_ground,
            agent_source = EXCLUDED.agent_source,
            landed_since = CASE
                WHEN EXCLUDED.on_ground = false THEN NULL
                WHEN aircraft_latest_position.on_ground = true THEN aircraft_latest_position.landed_since
                ELSE EXCLUDED.observed_at
            END,
            estimated_latitude = NULL,
            estimated_longitude = NULL,
            estimated_at = NULL
        WHERE EXCLUDED.observed_at > aircraft_latest_position.observed_at
        """;

    /**
     * Batched equivalent of persist(), for the global sweep's much larger
     * reports lists (~13k worldwide aircraft per run). Live log review
     * showed persist()'s one-row-at-a-time, up to 4 sequential DB
     * round-trips per report taking ~14 minutes at this scale — with
     * spring.task.scheduling.pool.size defaulting to 1 (see
     * application.yml), that blocked the 15s hot poll for the *entire*
     * 14 minutes, every sweep cycle. This collapses the same three writes
     * into batched multi-row statements — JDBC_BATCH_SIZE-row chunks
     * instead of one row per round-trip, roughly two orders of magnitude
     * fewer round-trips for a full sweep.
     *
     * Deliberately skips two things persist() does, both specifically
     * because this is the global-sweep path:
     *  - Per-row NOTIFY: nobody's actively watching an aircraft the
     *    *global* sweep found, by definition — the hot poll already
     *    covers whatever's in someone's current viewport, in real time.
     *    A sweep-found update surfaces on that aircraft's next
     *    /api/flights/live poll or pan/zoom instead, same as any other
     *    sweep-sourced data already does. Same reasoning as
     *    AgentOrchestrator.pollGlobalSweep's own javadoc on why
     *    enrichment is similarly skipped here.
     *  - Tracking which icao24s are newly-seen: pollGlobalSweep's caller
     *    never triggers enrichment from this method's result the way
     *    pollAll() does with persist()'s, so there's nothing to return.
     *
     * upsertLatestPosition's own WHERE EXCLUDED.observed_at > ... guard is
     * what makes it safe to run this unconditionally for every report
     * here, rather than needing to track (the way persist() does via
     * insertIgnoringDuplicate's Optional result) which ones were genuine
     * inserts: a true duplicate's observed_at can never be newer than
     * what's already stored, so the guard simply no-ops for it.
     */
    @Transactional
    public void persistBatch(String sourceName, List<RawPositionReport> reports) {
        if (reports.isEmpty()) return;

        List<String> distinctIcao24s = reports.stream().map(RawPositionReport::icao24).distinct().toList();
        jdbcTemplate.batchUpdate(AIRCRAFT_UPSERT_SQL, distinctIcao24s, JDBC_BATCH_SIZE,
                (PreparedStatement ps, String icao24) -> ps.setString(1, icao24));

        int[][] insertResults = jdbcTemplate.batchUpdate(POSITION_INSERT_SQL, reports, JDBC_BATCH_SIZE,
                (PreparedStatement ps, RawPositionReport r) -> bindPositionInsert(ps, r, sourceName));
        int written = 0;
        for (int[] chunkResults : insertResults) {
            for (int rowsAffected : chunkResults) {
                if (rowsAffected > 0) written++;
            }
        }

        jdbcTemplate.batchUpdate(LATEST_POSITION_UPSERT_SQL, reports, JDBC_BATCH_SIZE,
                (PreparedStatement ps, RawPositionReport r) -> bindLatestPositionUpsert(ps, r, sourceName));

        log.info("{}: wrote {} of {} position reports (batched)", sourceName, written, reports.size());
    }

    private static void bindPositionInsert(PreparedStatement ps, RawPositionReport r, String sourceName) throws SQLException {
        ps.setString(1, r.icao24());
        ps.setString(2, r.callsign());
        ps.setTimestamp(3, Timestamp.from(r.observedAt()));
        ps.setDouble(4, r.latitude());
        ps.setDouble(5, r.longitude());
        setNullableDouble(ps, 6, r.altitudeM());
        setNullableDouble(ps, 7, r.velocityMs());
        setNullableDouble(ps, 8, r.headingDeg());
        setNullableDouble(ps, 9, r.verticalRateMs());
        ps.setBoolean(10, r.onGround());
        ps.setString(11, sourceName);
    }

    private static void bindLatestPositionUpsert(PreparedStatement ps, RawPositionReport r, String sourceName) throws SQLException {
        ps.setString(1, r.icao24());
        ps.setString(2, r.callsign());
        Timestamp observedAt = Timestamp.from(r.observedAt());
        ps.setTimestamp(3, observedAt);
        ps.setDouble(4, r.latitude());
        ps.setDouble(5, r.longitude());
        setNullableDouble(ps, 6, r.altitudeM());
        setNullableDouble(ps, 7, r.velocityMs());
        setNullableDouble(ps, 8, r.headingDeg());
        setNullableDouble(ps, 9, r.verticalRateMs());
        ps.setBoolean(10, r.onGround());
        ps.setString(11, sourceName);
        ps.setBoolean(12, r.onGround());
        ps.setTimestamp(13, observedAt);
    }

    private static void setNullableDouble(PreparedStatement ps, int index, Double value) throws SQLException {
        if (value == null) {
            ps.setNull(index, Types.DOUBLE);
        } else {
            ps.setDouble(index, value);
        }
    }
}
