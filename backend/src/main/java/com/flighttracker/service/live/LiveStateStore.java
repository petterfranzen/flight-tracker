package com.flighttracker.service.live;

import com.flighttracker.dto.Bounds;
import com.flighttracker.dto.ClusterPoint;
import com.flighttracker.dto.LiveMarker;
import com.flighttracker.dto.LiveOverview;
import com.flighttracker.model.FlightPosition;
import com.flighttracker.repository.Timestamps;
import com.flighttracker.service.LiveVisibilityWindows;
import com.flighttracker.service.agent.RawPositionReport;
import com.flighttracker.service.confirmation.Confirmation;
import com.flighttracker.service.confirmation.ConfirmationStore;
import com.flighttracker.service.coverage.GapEstimate;
import com.flighttracker.service.coverage.TrackState;
import jakarta.annotation.PostConstruct;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Clock;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;

/**
 * In-memory replacement for the aircraft_latest_position table (cloud
 * migration A1 — see docs/cloud-migration/PLAN.md §6). One row per aircraft,
 * its most recent report plus EstimatorAgent's optional dead-reckoned
 * estimate — same shape and the same upsert/read semantics
 * aircraft_latest_position had, just a ConcurrentHashMap instead of a
 * Postgres table now that everything writing and reading it lives in one
 * process.
 *
 * At ~15k live aircraft, every read below (bbox filter, clustering, count,
 * callsign search, per-aircraft lookup) is a plain linear scan of
 * byIcao24.values() — no spatial index, no secondary index by callsign.
 * That's deliberate, not an oversight: 15k Java object comparisons is
 * sub-millisecond, dramatically cheaper than the network + planning + I/O
 * round trip a Postgres query cost for the same answer, and a spatial
 * index over a map that gets rewritten ~2.76M times/day (the global sweep
 * alone) would spend far more re-indexing than it would ever save a scan
 * of this size. Revisit only if the live set size itself grows by an
 * order of magnitude or more.
 *
 * Concurrency: every write goes through ConcurrentHashMap.compute (or
 * computeIfPresent), which locks only the affected bucket/key for the
 * duration of the remapping function — the same fine-grained safety the
 * single-row UPDATE ... WHERE guard gave in Postgres, without a database.
 * LiveAircraft itself is immutable (see its own javadoc): every write
 * replaces the map's entry wholesale, so a reader that already holds a
 * reference never observes a half-updated aircraft.
 */
@Component
public class LiveStateStore {

    private static final Logger log = LoggerFactory.getLogger(LiveStateStore.class);

    // Below this, a grid cell would be finer than markers are distinguishable
    // at anyway — matches FlightController's own MIN_CLUSTER_GRID_DEG.
    // Clamping happens in FlightController; clustered() just trusts its input.

    private final ConcurrentHashMap<String, LiveAircraft> byIcao24 = new ConcurrentHashMap<>();
    private final AtomicLong idSequence = new AtomicLong();
    private final JdbcTemplate jdbcTemplate;
    private final Clock clock;
    private final ConfirmationStore confirmationStore;

    public LiveStateStore(JdbcTemplate jdbcTemplate, Clock clock, ConfirmationStore confirmationStore) {
        this.jdbcTemplate = jdbcTemplate;
        this.clock = clock;
        this.confirmationStore = confirmationStore;
    }

    /**
     * Rebuilds the live set from flight_position on startup — this map
     * otherwise starts empty on every restart, which used to be fine when
     * aircraft_latest_position was a real table surviving the restart on
     * its own; now that it's in memory, without this the map would show
     * nothing until each aircraft's next real report came in. Only rows
     * newer than the longest LiveVisibilityWindows cutoff
     * (LONGEST_VISIBILITY) are worth considering; anything older could never
     * be "live" anyway. In practice this window is further bounded by
     * whatever PositionRetentionService has left in flight_position.
     *
     * One SQL statement, not one query per icao24: the landed_since streak
     * start (see LiveAircraft's own javadoc for what that means) is
     * resolved with the same LAG()-over-window-function technique
     * FlightPositionRepository.findCurrentLegTakeoffTime already uses for
     * an analogous "find the start of the current run" problem, so this
     * runs as a handful of index scans in SQLite rather than pulling a
     * bounded-but-still-large row set into Java to walk by hand.
     *
     * Cloud migration A2: ROW_NUMBER() OVER (... ORDER BY observed_at DESC)
     * = 1, not Postgres's DISTINCT ON (icao24) — SQLite has no DISTINCT ON.
     * Timestamps are plain INTEGER epoch millis (Timestamps.fromEpochMilli),
     * not java.sql.Timestamp.
     */
    @PostConstruct
    void warmUp() {
        long startedNanos = System.nanoTime();
        Instant cutoff = clock.instant().minus(LiveVisibilityWindows.LONGEST_VISIBILITY);
        // Two cheap steps instead of window functions over every row in the window
        // (about a day of positions, millions of rows, which made each restart wait
        // ~10-20 s): the newest report per aircraft comes from a GROUP BY that the
        // (icao24, observed_at, agent_source) index covers, and the landed streak
        // is only worked out for the aircraft whose newest report is on the ground,
        // by two indexed lookups each: the last airborne report, then the first
        // ground report after it (no airborne report in the window = the first
        // ground report in the window). Same result as the LAG()/ROW_NUMBER()
        // formulation it replaced (SqlitePersistenceIntegrationTest pins the
        // streak cases), about 0.5 s instead of 8-18 s on 2.7M rows.
        String sql = """
            WITH params(cut) AS (SELECT ?),
            last AS (
                SELECT icao24, MAX(observed_at) AS observed_at
                FROM flight_position
                WHERE observed_at > (SELECT cut FROM params)
                GROUP BY icao24
            )
            SELECT p.icao24, p.callsign, p.observed_at, p.latitude, p.longitude, p.altitude_m,
                   p.velocity_ms, p.heading_deg, p.vertical_rate_ms, p.on_ground, p.agent_source,
                   CASE WHEN p.on_ground = 1 THEN (
                       SELECT MIN(g.observed_at) FROM flight_position g
                       WHERE g.icao24 = p.icao24 AND g.on_ground = 1
                         AND g.observed_at > (SELECT cut FROM params)
                         AND g.observed_at > COALESCE((
                             SELECT MAX(a.observed_at) FROM flight_position a
                             WHERE a.icao24 = p.icao24 AND a.on_ground = 0
                               AND a.observed_at > (SELECT cut FROM params)
                               AND a.observed_at <= p.observed_at), 0)
                   ) END AS landed_since
            FROM last l
            JOIN flight_position p ON p.icao24 = l.icao24 AND p.observed_at = l.observed_at
            GROUP BY p.icao24
            """;

        int[] loaded = {0};
        jdbcTemplate.query(sql, (ResultSet rs) -> {
            boolean onGround = rs.getInt("on_ground") != 0;
            Long landedSinceMillis = onGround ? (Long) rs.getObject("landed_since") : null;
            LiveAircraft aircraft = new LiveAircraft(
                    idSequence.incrementAndGet(),
                    rs.getString("icao24"),
                    rs.getString("callsign"),
                    Timestamps.fromEpochMilli(rs.getLong("observed_at")),
                    rs.getDouble("latitude"),
                    rs.getDouble("longitude"),
                    nullableDouble(rs, "altitude_m"),
                    nullableDouble(rs, "velocity_ms"),
                    nullableDouble(rs, "heading_deg"),
                    nullableDouble(rs, "vertical_rate_ms"),
                    onGround,
                    rs.getString("agent_source"),
                    Timestamps.fromEpochMilli(landedSinceMillis),
                    null, null, null, null); // no estimate to restore — EstimatorAgent recomputes on its own next cycle
            byIcao24.put(aircraft.icao24(), aircraft);
            loaded[0]++;
        }, cutoff.toEpochMilli());
        log.info("LiveStateStore warm-up: loaded {} aircraft from flight_position in {} ms", loaded[0], (System.nanoTime() - startedNanos) / 1_000_000);
    }

    private static Double nullableDouble(ResultSet rs, String column) throws SQLException {
        double v = rs.getDouble(column);
        return rs.wasNull() ? null : v;
    }

    /** True only on a genuinely fresh database — see AgentOrchestrator.seedOnStartup. */
    public boolean isEmpty() {
        return byIcao24.isEmpty();
    }

    /**
     * Upserts one real position report. Ports FlightPositionRepository.
     * upsertLatestPosition's SQL exactly: only accepted when strictly newer
     * than what's currently stored (never regresses "latest"); landed_since
     * resets to this report's time the moment on_ground flips true, carries
     * forward while it stays true, clears on the next false;
     * estimated_latitude/estimated_longitude/estimated_at are always
     * cleared — a genuine new report always supersedes any prior
     * dead-reckoned guess immediately.
     *
     * @return true if this report was accepted (first time seeing this
     *         icao24, or strictly newer than what was stored); false if it
     *         was a stale/duplicate report and the store was left unchanged.
     */
    public boolean upsert(RawPositionReport report, String agentSource) {
        Instant observedAt = report.observedAt();
        AtomicReference<Boolean> accepted = new AtomicReference<>(Boolean.FALSE);
        byIcao24.compute(report.icao24(), (key, existing) -> {
            if (existing != null && !observedAt.isAfter(existing.observedAt())) {
                return existing; // stale or duplicate — never regress "latest"
            }
            accepted.set(Boolean.TRUE);
            long id = existing != null ? existing.id() : idSequence.incrementAndGet();
            return new LiveAircraft(id, report.icao24(), report.callsign(), observedAt,
                    report.latitude(), report.longitude(), report.altitudeM(), report.velocityMs(),
                    report.headingDeg(), report.verticalRateMs(), report.onGround(), agentSource,
                    landedSince(existing, report.onGround(), observedAt), null, null, null, null);
        });
        return accepted.get();
    }

    private static Instant landedSince(LiveAircraft existing, boolean onGround, Instant observedAt) {
        if (!onGround) return null;
        if (existing != null && existing.onGround()) {
            return existing.landedSince(); // carry the streak forward
        }
        return observedAt; // just transitioned (or first-ever report) — streak starts now
    }

    /**
     * Writes (or clears) EstimatorAgent's dead-reckoned estimate for one
     * aircraft. Ports EstimatorAgent's own ESTIMATE_UPDATE_SQL exactly: the
     * write only applies if this aircraft's stored observed_at still equals
     * expectedObservedAt — the same optimistic-concurrency guard that SQL's
     * {@code WHERE icao24 = ? AND observed_at = ?} gave against a real
     * report landing (and clearing any estimate, per upsert() above)
     * between EstimatorAgent's read and this write. Without it, a stale
     * projection computed from data already superseded by a real report
     * could clobber that fresher state.
     *
     * @param estimate the dead-reckoned position and when it was made;
     *                 {@link EstimatedPosition#CLEAR} (all fields null) to
     *                 explicitly clear a stale estimate — same "NULL is a
     *                 real, deliberate write" case the original SQL handled.
     * @return true if the write applied (observed_at still matched); false
     *         if it was skipped, either because the aircraft is no longer
     *         live at all, or because a real report superseded it first.
     */
    public boolean writeEstimate(String icao24, Instant expectedObservedAt, EstimatedPosition estimate) {
        return writeIfUnchanged(icao24, expectedObservedAt,
                new Estimate(estimate.latitude(), estimate.longitude(), estimate.at(), null));
    }

    /**
     * {@link #writeEstimate}'s input: EstimatorAgent's dead-reckoned display
     * position and when it was computed. All three null clears the estimate.
     */
    public record EstimatedPosition(Double latitude, Double longitude, Instant at) {
        /** Clears a stale estimate: every field null. */
        public static final EstimatedPosition CLEAR = new EstimatedPosition(null, null, null);
    }

    /**
     * Same compare-and-set as {@link #writeEstimate}, for the coverage-gap
     * estimator: stores the {@link GapEstimate} and makes its position the
     * display position. A newer real report (upsert) clears it again.
     *
     * @return true if the write applied; false if the aircraft is gone or a
     *         real report superseded the one this estimate was computed from.
     */
    public boolean writeGapEstimate(String icao24, Instant expectedObservedAt, GapEstimate gap) {
        return writeIfUnchanged(icao24, expectedObservedAt, new Estimate(gap.estLat(), gap.estLon(), gap.at(), gap));
    }

    /** An estimate to store: the display position it moves to, when it was made, and the gap estimate (or null). */
    private record Estimate(Double latitude, Double longitude, Instant at, GapEstimate gap) {
        LiveAircraft applyTo(LiveAircraft existing) {
            return new LiveAircraft(existing.id(), existing.icao24(), existing.callsign(), existing.observedAt(),
                    existing.latitude(), existing.longitude(), existing.altitudeM(), existing.velocityMs(),
                    existing.headingDeg(), existing.verticalRateMs(), existing.onGround(), existing.agentSource(),
                    existing.landedSince(), latitude, longitude, at, gap);
        }
    }

    /** The compare-and-set both estimate writes share: applies only while observed_at still equals {@code expectedObservedAt}. */
    private boolean writeIfUnchanged(String icao24, Instant expectedObservedAt, Estimate estimate) {
        AtomicReference<Boolean> applied = new AtomicReference<>(Boolean.FALSE);
        byIcao24.computeIfPresent(icao24, (key, existing) -> {
            if (!existing.observedAt().equals(expectedObservedAt)) {
                return existing; // superseded by a real report since this cycle's read
            }
            applied.set(Boolean.TRUE);
            return estimate.applyTo(existing);
        });
        return applied.get();
    }

    /** icao24s that currently have a non-null estimate — see EstimatorAgent's skip-if-already-NULL optimisation. */
    public Set<String> icao24sWithEstimate() {
        Set<String> out = new HashSet<>();
        for (LiveAircraft a : byIcao24.values()) {
            if (a.estimatedLatitude() != null) out.add(a.icao24());
        }
        return out;
    }

    /**
     * The aircraft's track state, the same mapping TrackStatus.from(LiveAircraft,
     * confirmation) uses — a provider confirmation included, from the in-memory
     * {@link ConfirmationStore} (one map lookup, no I/O). Cheap enough to stamp on
     * every marker of the bulk snapshot.
     *
     * <p>The confirmed states are what the map's landed-display rule needs to see:
     * an aircraft a provider has put at a gate is stamped {@code AT_GATE}, so the
     * map keeps it on the map (its gate is known; the gate display draws it there
     * once selected) even though its last report is old. Without that layer an
     * on-ground aircraft reads {@code ON_GROUND}, which the rule hides.
     */
    private TrackState stateOf(LiveAircraft a) {
        Optional<Confirmation> confirmation = confirmationStore.forAircraft(a);
        if (confirmation.isPresent()) {
            return confirmation.get().gateAt() != null ? TrackState.AT_GATE : TrackState.LANDED_CONFIRMED;
        }
        if (a.onGround()) return TrackState.ON_GROUND;
        GapEstimate gap = a.gap();
        return gap == null ? TrackState.LIVE : gap.state();
    }

    private static boolean isLive(LiveAircraft a, Instant staleAirborneCutoff, Instant landedCutoff) {
        return (!a.onGround() && a.observedAt().isAfter(staleAirborneCutoff))
                || (a.onGround() && a.landedSince() != null && a.landedSince().isAfter(landedCutoff));
    }

    /** Coalesced (estimate-aware) full-field view, mirroring FlightPositionRepository.findLive/findLiveInBounds. bounds null = every live aircraft, worldwide. */
    public List<FlightPosition> liveFlightPositions(Instant staleAirborneCutoff, Instant landedCutoff, Bounds bounds) {
        List<FlightPosition> out = new ArrayList<>();
        for (LiveAircraft a : byIcao24.values()) {
            if (!isLive(a, staleAirborneCutoff, landedCutoff)) continue;
            if (bounds != null && !bounds.contains(a.displayLatitude(), a.displayLongitude())) continue;
            out.add(toFlightPosition(a));
        }
        return out;
    }

    /** Trimmed marker view for the map's bulk /live fetch, mirroring findLiveMarkers/findLiveMarkersInBounds. bounds null = worldwide. */
    public List<LiveMarker> liveMarkers(Instant staleAirborneCutoff, Instant landedCutoff, Bounds bounds) {
        List<LiveMarker> out = new ArrayList<>();
        for (LiveAircraft a : byIcao24.values()) {
            if (!isLive(a, staleAirborneCutoff, landedCutoff)) continue;
            if (bounds != null && !bounds.contains(a.displayLatitude(), a.displayLongitude())) continue;
            out.add(marker(a));
        }
        return out;
    }

    private LiveMarker marker(LiveAircraft a) {
        return new LiveMarkerView(a.icao24(), a.callsign(), a.observedAt(),
                a.displayLatitude(), a.displayLongitude(), a.headingDeg(), a.onGround(), stateOf(a));
    }

    /**
     * Forgets every aircraft whose last report is older than `cutoff`. The map
     * used to only ever grow (aircraft were filtered when read, never
     * removed), so every request scanned every aircraft seen since the last
     * restart. With `cutoff` = now - LONGEST_VISIBILITY this never changes
     * what isLive says: an aircraft silent that long is not live under
     * either rule. One that reports again simply starts a new entry.
     *
     * @return how many were removed
     */
    public int evictSilentBefore(Instant cutoff) {
        int before = byIcao24.size();
        byIcao24.values().removeIf(a -> a.observedAt().isBefore(cutoff));
        return before - byIcao24.size();
    }

    /** Aircraft in the air that reported since `activeSince` (the "active traffic" rule used by the clusters). */
    public long countActive(Instant activeSince) {
        long count = 0;
        for (LiveAircraft a : byIcao24.values()) {
            if (!a.onGround() && !a.observedAt().isBefore(activeSince)) count++;
        }
        return count;
    }

    /** Mirrors FlightPositionRepository.countLive. */
    public long countLive(Instant staleAirborneCutoff, Instant landedCutoff) {
        long count = 0;
        for (LiveAircraft a : byIcao24.values()) {
            if (isLive(a, staleAirborneCutoff, landedCutoff)) count++;
        }
        return count;
    }

    private List<LiveAircraft> activeInBounds(ActiveTrafficQuery query) {
        List<LiveAircraft> out = new ArrayList<>();
        for (LiveAircraft a : byIcao24.values()) {
            if (!isLive(a, query.staleAirborneCutoff(), query.landedCutoff())) continue;
            if (a.onGround() || a.observedAt().isBefore(query.activeSince())) continue;
            if (!query.bounds().contains(a.displayLatitude(), a.displayLongitude())) continue;
            out.add(a);
        }
        return out;
    }

    /**
     * Aggregates the live aircraft in {@code bounds} into grid cells of
     * {@code gridDeg} (the same floor(coalesced-lat/gridDeg)*gridDeg
     * bucketing FlightPositionRepository.findLiveClusteredInBounds used),
     * but each cluster is placed at the <em>mean position of the aircraft
     * in it</em>, not the cell's centre. A centre-placed bubble can sit in
     * empty sea, or over a different country than its traffic, and jumps
     * whenever the zoom (and so the grid) changes; the centroid sits where
     * the traffic is. The cell itself is still the grouping unit, so counts
     * are unchanged and a cluster's position stays inside its own cell.
     *
     * Only <em>active traffic</em> is counted: in the air and reported at or
     * after {@code activeSince} (see LiveVisibilityWindows.ACTIVE_TRAFFIC_WINDOW).
     * Parked aircraft, and ones that have gone silent, are still live (they
     * are returned individually and drawn once zoomed in) but would make an
     * airport read as a busy sky if they were bubbled with the flights.
     * gridDeg is trusted as already clamped by the caller (see
     * FlightController's MIN/MAX_CLUSTER_GRID_DEG).
     */
    public List<ClusterPoint> clustered(ActiveTrafficQuery query, double gridDeg) {
        return LiveOverviews.bucket(activeInBounds(query), gridDeg);
    }

    /**
     * The zoomed-out map in one answer: up to {@code maxPlanes} of the
     * <em>most active</em> aircraft in {@code bounds}, to be drawn as planes,
     * and {@link #clustered}-style bubbles for all the rest of the active
     * traffic. An aircraft returned as a plane is not counted in any bubble,
     * so planes plus bubble counts is the active traffic in view.
     *
     * "Most active" is the fastest airborne aircraft (cruising jets over
     * slow light aircraft and helicopters), newest report as the tie-break.
     * At most {@code perCell} are taken from any one grid cell, so a hub
     * can't use up the whole allowance and every populated area of the
     * viewport shows some real planes alongside its bubble. gridDeg is
     * trusted as already clamped by the caller.
     */
    public LiveOverview overview(ActiveTrafficQuery query, PlaneAllowance allowance) {
        return LiveOverviews.overview(activeInBounds(query), allowance, this::marker);
    }

    /**
     * The zoomed-out map without clustering: the active aircraft in
     * {@code bounds}, at most one per {@code cellDeg} cell, the
     * <em>first discovered</em> one wins its cell (lowest {@link LiveAircraft#id()},
     * the sequence number assigned the first time this process saw the
     * aircraft). Returned in that same order, so a client can treat list order
     * as discovery order. A cell is about half a plane icon wide, so planes
     * dropped here would have been drawn underneath the one that is kept; the
     * client's exact overlap pass takes it from there. At most
     * {@code maxPlanes} are returned. cellDeg is trusted as already clamped.
     */
    public LiveOverview discovered(ActiveTrafficQuery query, double cellDeg, int maxPlanes) {
        return LiveOverviews.discovered(activeInBounds(query), cellDeg, maxPlanes, this::marker);
    }

    /**
     * Callsign search, mirroring FlightPositionRepository.searchLive:
     * live aircraft whose callsign contains query (case-insensitive),
     * prefix matches ranked first, then alphabetical, limited. query is
     * matched as a plain substring — no LIKE-style escaping needed any
     * more now this isn't a SQL pattern (see FlightController.search).
     */
    public List<FlightPosition> searchByCallsign(String query, Instant staleAirborneCutoff, Instant landedCutoff, int limit) {
        String needle = query.toLowerCase();
        return byIcao24.values().stream()
                .filter(a -> isLive(a, staleAirborneCutoff, landedCutoff))
                .filter(a -> a.callsign() != null && a.callsign().toLowerCase().contains(needle))
                .sorted((a, b) -> {
                    boolean aPrefix = a.callsign().toLowerCase().startsWith(needle);
                    boolean bPrefix = b.callsign().toLowerCase().startsWith(needle);
                    if (aPrefix != bPrefix) return aPrefix ? -1 : 1;
                    return a.callsign().compareTo(b.callsign());
                })
                .limit(limit)
                .map(LiveStateStore::toFlightPosition)
                .toList();
    }

    /**
     * Every currently-live aircraft's raw in-memory state (not converted to
     * FlightPosition) — for FlightController's airport search, which needs
     * each candidate's icao24 to join against the `aircraft`/`airport`
     * tables (still in Postgres) before it knows whether a given aircraft
     * matches at all. See FlightController.searchByAirport.
     */
    public List<LiveAircraft> liveAircraft(Instant staleAirborneCutoff, Instant landedCutoff) {
        List<LiveAircraft> out = new ArrayList<>();
        for (LiveAircraft a : byIcao24.values()) {
            if (isLive(a, staleAirborneCutoff, landedCutoff)) out.add(a);
        }
        return out;
    }

    /** Mirrors FlightPositionRepository.findLatestPosition — coalesced, no liveness-window filter (see that method's own javadoc for why). */
    public Optional<FlightPosition> findLatestPosition(String icao24) {
        return Optional.ofNullable(byIcao24.get(icao24)).map(LiveStateStore::toFlightPosition);
    }

    /** Mirrors FlightPositionRepository.findLatestCallsign. */
    public Optional<String> findLatestCallsign(String icao24) {
        return Optional.ofNullable(byIcao24.get(icao24)).map(LiveAircraft::callsign);
    }

    /**
     * Raw current state for one aircraft, not converted to FlightPosition —
     * for PositionPersistenceService's skip-unchanged-ground write
     * reduction (cloud migration A2, PLAN.md §6 item 7), which needs
     * onGround/latitude/longitude/headingDeg from the *last stored* report
     * to compare a new report against. LiveStateStore's own entry already
     * *is* that last-stored report (upsert() is only ever called right
     * after a real flight_position insert succeeds), so this is a free
     * in-memory read instead of a second query.
     */
    public Optional<LiveAircraft> get(String icao24) {
        return Optional.ofNullable(byIcao24.get(icao24));
    }

    private static FlightPosition toFlightPosition(LiveAircraft a) {
        return new FlightPosition(a.id(), a.icao24(), a.callsign(), a.observedAt(),
                a.displayLatitude(), a.displayLongitude(), a.altitudeM(), a.velocityMs(),
                a.headingDeg(), a.verticalRateMs(), a.onGround(), a.agentSource());
    }
}
