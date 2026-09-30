package com.flighttracker.service.agent;

import com.flighttracker.model.FlightPosition;
import com.flighttracker.repository.AircraftRepository;
import com.flighttracker.repository.FlightPositionRepository;
import com.flighttracker.service.live.LiveAircraft;
import com.flighttracker.service.live.LiveStateStore;
import com.flighttracker.service.live.PositionsPersistedEvent;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.sql.PreparedStatement;
import java.sql.SQLException;
import java.sql.Types;
import java.time.Clock;
import java.util.ArrayList;
import java.util.List;
import java.util.Objects;

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
 *
 * persist() also publishes a PositionsPersistedEvent for LiveFeedBroadcaster
 * once its transaction commits — replaces the Postgres pub/sub channel bridge
 * an earlier, multi-container version of this app used to reach the "api"
 * container's WebSocket clients from here, now that both live in the same
 * process (see service/live/PositionsPersistedEvent).
 */
@Service
public class PositionPersistenceService {

    private static final Logger log = LoggerFactory.getLogger(PositionPersistenceService.class);

    private final AircraftRepository aircraftRepository;
    private final FlightPositionRepository positionRepository;
    private final JdbcTemplate jdbcTemplate;
    private final ApplicationEventPublisher eventPublisher;
    private final LiveStateStore liveStateStore;
    private final Clock clock;

    // Cloud migration A2 (PLAN.md §6 item 7): skips inserting an on_ground
    // report that's identical (lat/lon/heading) to the aircraft's last
    // *stored* report — a parked aircraft's global-sweep hit otherwise
    // writes a byte-for-byte duplicate row every global-sweep-interval-seconds
    // for as long as it sits at the gate. Airborne reports are never
    // skipped (see isUnchangedGroundReport) — a moving aircraft's position
    // is never truly unchanged, and /api/usage's distance/airtime calc
    // needs every real airborne sample.
    @Value("${flighttracker.persistence.skip-unchanged-ground:true}")
    private boolean skipUnchangedGround;

    public PositionPersistenceService(AircraftRepository aircraftRepository,
                                       FlightPositionRepository positionRepository,
                                       JdbcTemplate jdbcTemplate,
                                       ApplicationEventPublisher eventPublisher,
                                       LiveStateStore liveStateStore,
                                       Clock clock) {
        this.aircraftRepository = aircraftRepository;
        this.positionRepository = positionRepository;
        this.jdbcTemplate = jdbcTemplate;
        this.eventPublisher = eventPublisher;
        this.liveStateStore = liveStateStore;
        this.clock = clock;
    }

    /**
     * True only on a genuinely fresh database — see
     * AgentOrchestrator.seedOnStartup. LiveStateStore.warmUp() (its own
     * @PostConstruct, guaranteed to run before this service is even fully
     * constructed — see LiveStateStore being a constructor-injected
     * dependency here) already rebuilt the live set from any existing
     * flight_position rows, so an empty store here means there was nothing
     * to rebuild from, not just "nothing polled yet this process".
     */
    public boolean hasNoPositions() {
        return liveStateStore.isEmpty();
    }

    /**
     * True when {@code r} is an on_ground report whose lat/lon/heading
     * exactly match LiveStateStore's current entry for this aircraft (also
     * on_ground) — see skipUnchangedGround's own field javadoc. Reads
     * LiveStateStore rather than issuing a query: its entry for this
     * icao24 already *is* the last stored report, since upsert() is only
     * ever called right after a real insert succeeds.
     */
    private boolean isUnchangedGroundReport(RawPositionReport r) {
        if (!skipUnchangedGround || !r.onGround()) return false;
        return liveStateStore.get(r.icao24())
                .filter(LiveAircraft::onGround)
                .filter(existing -> existing.latitude() == r.latitude()
                        && existing.longitude() == r.longitude()
                        && Objects.equals(existing.headingDeg(), r.headingDeg()))
                .isPresent();
    }

    /** Returns the reports for icao24s that were newly seen this cycle (not already known aircraft). */
    @Transactional
    public List<RawPositionReport> persist(String sourceName, List<RawPositionReport> reports) {
        int written = 0;
        List<RawPositionReport> newAircraft = new ArrayList<>();
        // Collected across the whole cycle rather than published row by
        // row: one event per persist() call means LiveFeedBroadcaster does
        // one viewport-filter pass over one small batch instead of N
        // separate ones — same batching reasoning as the JDBC batch size
        // below, just for the in-process fan-out instead of a DB round trip.
        List<FlightPosition> persisted = new ArrayList<>();
        for (RawPositionReport r : reports) {
            // insertIfAbsent's own return value is exactly "was this newly
            // inserted" — no separate existsById check-then-insert needed
            // (that was the JPA-entity-era shape; see AircraftRepository.
            // insertIfAbsent's own javadoc).
            if (aircraftRepository.insertIfAbsent(r.icao24())) {
                newAircraft.add(r);
            }
            if (isUnchangedGroundReport(r)) continue; // write reduction — see that method's own javadoc
            var inserted = positionRepository.insertIgnoringDuplicate(
                    r.icao24(), r.callsign(), r.observedAt(),
                    r.latitude(), r.longitude(), r.altitudeM(),
                    r.velocityMs(), r.headingDeg(), r.verticalRateMs(),
                    r.onGround(), sourceName);
            if (inserted.isPresent()) {
                // Keeps LiveStateStore (the in-memory "latest per aircraft"
                // map — see its own javadoc) in step with the append-only
                // history — every accepted report updates both.
                liveStateStore.upsert(
                        r.icao24(), r.callsign(), r.observedAt(),
                        r.latitude(), r.longitude(), r.altitudeM(),
                        r.velocityMs(), r.headingDeg(), r.verticalRateMs(),
                        r.onGround(), sourceName);
                persisted.add(inserted.get());
                written++;
            }
            // else: another agent already reported this exact (icao24, observed_at) tick — expected, skip
        }
        if (!persisted.isEmpty()) {
            // LiveFeedBroadcaster's WebSocket clients live in this same
            // process now — no cross-container Postgres pub/sub channel
            // bridge needed (see the deleted PositionNotificationListener).
            // Published from inside this @Transactional method, so
            // LiveFeedBroadcaster's @TransactionalEventListener(AFTER_COMMIT)
            // only actually runs once this transaction has committed —
            // same "don't broadcast a write that might still roll back"
            // guarantee the old pub/sub channel's commit-gated delivery gave for free.
            eventPublisher.publishEvent(new PositionsPersistedEvent(persisted));
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
    // now() has no SQLite equivalent — first_seen_at/last_seen_at bind from
    // the injected Clock instead, like every other timestamp write in this
    // app (cloud migration A2, PLAN.md §6 item 4).
    private static final String AIRCRAFT_UPSERT_SQL = """
        INSERT INTO aircraft (icao24, first_seen_at, last_seen_at)
        VALUES (?, ?, ?)
        ON CONFLICT (icao24) DO NOTHING
        """;

    // Same statement as FlightPositionRepository.insertIgnoringDuplicate,
    // positional params instead of named ones for raw JdbcTemplate use.
    // inserted_at also binds from Clock, same reasoning as above.
    private static final String POSITION_INSERT_SQL = """
        INSERT INTO flight_position
            (icao24, callsign, observed_at, latitude, longitude, altitude_m,
             velocity_ms, heading_deg, vertical_rate_ms, on_ground, agent_source, inserted_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (icao24, observed_at, agent_source) DO NOTHING
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
     *  - Publishing a PositionsPersistedEvent: nobody's actively watching an aircraft the
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
     * LiveStateStore.upsert's own observed_at guard is what makes it safe
     * to call unconditionally for every report here, rather than needing
     * to track (the way persist() does via insertIgnoringDuplicate's
     * Optional result) which ones were genuine inserts: a true duplicate's
     * observed_at can never be newer than what's already stored, so the
     * guard simply no-ops for it.
     */
    @Transactional
    public void persistBatch(String sourceName, List<RawPositionReport> reports) {
        if (reports.isEmpty()) return;

        // Write reduction (PLAN.md §6 item 7) applied before batching: a
        // parked aircraft's identical on_ground report is dropped here so
        // it costs neither the flight_position insert below nor a
        // LiveStateStore.upsert (also skipped for these, further down —
        // there's nothing new to record). distinctIcao24s for the aircraft
        // upsert is derived from this filtered list too: every icao24 in
        // it is one LiveStateStore already has a record of onGround=true
        // for, so it can never be a new aircraft.
        List<RawPositionReport> toInsert = reports.stream().filter(r -> !isUnchangedGroundReport(r)).toList();

        // PLAN.md §6 item 5: "verify < 2s on this machine and log the
        // duration" — timed around just the two executeBatch calls (the
        // actual DB work this item is about), not the write-reduction
        // filtering above or the LiveStateStore fan-out below.
        long batchStart = System.nanoTime();

        long now = clock.millis();
        List<String> distinctIcao24s = toInsert.stream().map(RawPositionReport::icao24).distinct().toList();
        jdbcTemplate.batchUpdate(AIRCRAFT_UPSERT_SQL, distinctIcao24s, JDBC_BATCH_SIZE,
                (PreparedStatement ps, String icao24) -> {
                    ps.setString(1, icao24);
                    ps.setLong(2, now);
                    ps.setLong(3, now);
                });

        int[][] insertResults = jdbcTemplate.batchUpdate(POSITION_INSERT_SQL, toInsert, JDBC_BATCH_SIZE,
                (PreparedStatement ps, RawPositionReport r) -> bindPositionInsert(ps, r, sourceName, now));
        int written = 0;
        for (int[] chunkResults : insertResults) {
            for (int rowsAffected : chunkResults) {
                if (rowsAffected > 0) written++;
            }
        }

        long batchMs = (System.nanoTime() - batchStart) / 1_000_000;
        log.info("{}: batched insert of {} rows took {} ms", sourceName, toInsert.size(), batchMs);
        if (batchMs >= 2000) {
            log.warn("{}: batched insert of {} rows took {} ms — over the 2s budget", sourceName, toInsert.size(), batchMs);
        }

        // LiveStateStore.upsert is an in-memory ConcurrentHashMap.compute —
        // no JDBC batching to do here, unlike the two DB writes above; a
        // plain loop over ~13k reports is microseconds, not worth building
        // a batch API for.
        for (RawPositionReport r : toInsert) {
            liveStateStore.upsert(r.icao24(), r.callsign(), r.observedAt(),
                    r.latitude(), r.longitude(), r.altitudeM(),
                    r.velocityMs(), r.headingDeg(), r.verticalRateMs(),
                    r.onGround(), sourceName);
        }

        log.info("{}: wrote {} of {} position reports (batched, {} skipped as unchanged-ground)",
                sourceName, written, reports.size(), reports.size() - toInsert.size());
    }

    private static void bindPositionInsert(PreparedStatement ps, RawPositionReport r, String sourceName, long insertedAt) throws SQLException {
        ps.setString(1, r.icao24());
        ps.setString(2, r.callsign());
        ps.setLong(3, r.observedAt().toEpochMilli());
        ps.setDouble(4, r.latitude());
        ps.setDouble(5, r.longitude());
        setNullableDouble(ps, 6, r.altitudeM());
        setNullableDouble(ps, 7, r.velocityMs());
        setNullableDouble(ps, 8, r.headingDeg());
        setNullableDouble(ps, 9, r.verticalRateMs());
        ps.setInt(10, r.onGround() ? 1 : 0);
        ps.setString(11, sourceName);
        ps.setLong(12, insertedAt);
    }

    private static void setNullableDouble(PreparedStatement ps, int index, Double value) throws SQLException {
        if (value == null) {
            ps.setNull(index, Types.DOUBLE);
        } else {
            ps.setDouble(index, value);
        }
    }
}
