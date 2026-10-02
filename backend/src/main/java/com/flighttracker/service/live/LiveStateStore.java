package com.flighttracker.service.live;

import com.flighttracker.dto.Bounds;
import com.flighttracker.dto.ClusterPoint;
import com.flighttracker.dto.LiveMarker;
import com.flighttracker.model.FlightPosition;
import com.flighttracker.repository.Timestamps;
import com.flighttracker.service.LiveVisibilityWindows;
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
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
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

    public LiveStateStore(JdbcTemplate jdbcTemplate, Clock clock) {
        this.jdbcTemplate = jdbcTemplate;
        this.clock = clock;
    }

    /**
     * Rebuilds the live set from flight_position on startup — this map
     * otherwise starts empty on every restart, which used to be fine when
     * aircraft_latest_position was a real table surviving the restart on
     * its own; now that it's in memory, without this the map would show
     * nothing until each aircraft's next real report came in. Only rows
     * newer than the longest LiveVisibilityWindows cutoff (48h — both
     * STALE_AIRBORNE_BOUND and LANDED_VISIBILITY) are worth considering;
     * anything older could never be "live" anyway. In practice this window
     * is further bounded by whatever PositionRetentionService has left in
     * flight_position (24h by default), so the query below never actually
     * has to scan a full 48h of history.
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
        Instant cutoff = clock.instant().minus(LiveVisibilityWindows.STALE_AIRBORNE_BOUND);
        String sql = """
            WITH windowed AS (
                SELECT icao24, callsign, observed_at, latitude, longitude, altitude_m,
                       velocity_ms, heading_deg, vertical_rate_ms, on_ground, agent_source,
                       LAG(on_ground) OVER (PARTITION BY icao24 ORDER BY observed_at) AS prev_on_ground,
                       ROW_NUMBER() OVER (PARTITION BY icao24 ORDER BY observed_at DESC) AS rn
                FROM flight_position
                WHERE observed_at > ?
            ),
            latest AS (
                SELECT * FROM windowed WHERE rn = 1
            ),
            landed_transitions AS (
                SELECT icao24, observed_at AS landed_since
                FROM windowed
                WHERE on_ground = 1 AND prev_on_ground IS NOT 1
            )
            SELECT latest.icao24, latest.callsign, latest.observed_at, latest.latitude, latest.longitude,
                   latest.altitude_m, latest.velocity_ms, latest.heading_deg, latest.vertical_rate_ms,
                   latest.on_ground, latest.agent_source,
                   (SELECT MAX(lt.landed_since) FROM landed_transitions lt
                     WHERE lt.icao24 = latest.icao24 AND lt.landed_since <= latest.observed_at) AS landed_since
            FROM latest
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
                    null, null, null); // no estimate to restore — EstimatorAgent recomputes on its own next cycle
            byIcao24.put(aircraft.icao24(), aircraft);
            loaded[0]++;
        }, cutoff.toEpochMilli());
        log.info("LiveStateStore warm-up: loaded {} aircraft from flight_position", loaded[0]);
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
    public boolean upsert(String icao24, String callsign, Instant observedAt,
                           double latitude, double longitude, Double altitudeM,
                           Double velocityMs, Double headingDeg, Double verticalRateMs,
                           boolean onGround, String agentSource) {
        AtomicReference<Boolean> accepted = new AtomicReference<>(Boolean.FALSE);
        byIcao24.compute(icao24, (key, existing) -> {
            if (existing != null && !observedAt.isAfter(existing.observedAt())) {
                return existing; // stale or duplicate — never regress "latest"
            }
            accepted.set(Boolean.TRUE);
            Instant landedSince;
            if (!onGround) {
                landedSince = null;
            } else if (existing != null && existing.onGround()) {
                landedSince = existing.landedSince(); // carry the streak forward
            } else {
                landedSince = observedAt; // just transitioned (or first-ever report) — streak starts now
            }
            long id = existing != null ? existing.id() : idSequence.incrementAndGet();
            return new LiveAircraft(id, icao24, callsign, observedAt, latitude, longitude,
                    altitudeM, velocityMs, headingDeg, verticalRateMs, onGround, agentSource,
                    landedSince, null, null, null);
        });
        return accepted.get();
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
     * @param estimatedLatitude  null (together with estimatedLongitude/At)
     *                           to explicitly clear a stale estimate — same
     *                           "NULL is a real, deliberate write" case the
     *                           original SQL handled.
     * @return true if the write applied (observed_at still matched); false
     *         if it was skipped, either because the aircraft is no longer
     *         live at all, or because a real report superseded it first.
     */
    public boolean writeEstimate(String icao24, Instant expectedObservedAt,
                                  Double estimatedLatitude, Double estimatedLongitude, Instant estimatedAt) {
        AtomicReference<Boolean> applied = new AtomicReference<>(Boolean.FALSE);
        byIcao24.computeIfPresent(icao24, (key, existing) -> {
            if (!existing.observedAt().equals(expectedObservedAt)) {
                return existing; // superseded by a real report since this cycle's read
            }
            applied.set(Boolean.TRUE);
            return new LiveAircraft(existing.id(), existing.icao24(), existing.callsign(), existing.observedAt(),
                    existing.latitude(), existing.longitude(), existing.altitudeM(), existing.velocityMs(),
                    existing.headingDeg(), existing.verticalRateMs(), existing.onGround(), existing.agentSource(),
                    existing.landedSince(), estimatedLatitude, estimatedLongitude, estimatedAt);
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
            out.add(new LiveMarkerView(a.icao24(), a.callsign(), a.observedAt(),
                    a.displayLatitude(), a.displayLongitude(), a.headingDeg(), a.onGround()));
        }
        return out;
    }

    /** Mirrors FlightPositionRepository.countLive. */
    public long countLive(Instant staleAirborneCutoff, Instant landedCutoff) {
        long count = 0;
        for (LiveAircraft a : byIcao24.values()) {
            if (isLive(a, staleAirborneCutoff, landedCutoff)) count++;
        }
        return count;
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
    public List<ClusterPoint> clustered(Instant staleAirborneCutoff, Instant landedCutoff, Instant activeSince, Bounds bounds, double gridDeg) {
        record BucketKey(double lat, double lon) { }
        final class Sum {
            long count;
            double lat;
            double lon;
        }
        Map<BucketKey, Sum> cells = new HashMap<>();
        for (LiveAircraft a : byIcao24.values()) {
            if (!isLive(a, staleAirborneCutoff, landedCutoff)) continue;
            if (a.onGround() || a.observedAt().isBefore(activeSince)) continue;
            double lat = a.displayLatitude();
            double lon = a.displayLongitude();
            if (!bounds.contains(lat, lon)) continue;
            double bucketLat = Math.floor(lat / gridDeg) * gridDeg;
            double bucketLon = Math.floor(lon / gridDeg) * gridDeg;
            Sum sum = cells.computeIfAbsent(new BucketKey(bucketLat, bucketLon), k -> new Sum());
            sum.count++;
            sum.lat += lat;
            sum.lon += lon;
        }
        List<ClusterPoint> out = new ArrayList<>(cells.size());
        for (Sum sum : cells.values()) {
            out.add(new ClusterPointView(sum.lat / sum.count, sum.lon / sum.count, sum.count));
        }
        return out;
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

    /** Raw (never coalesced with an estimate) lat/lon — mirrors FlightPositionRepository.findRawLatestLatLon; see that method's own javadoc for why raw matters here. */
    public Optional<RawLatLon> findRawLatestLatLon(String icao24) {
        return Optional.ofNullable(byIcao24.get(icao24)).map(a -> new RawLatLon(a.latitude(), a.longitude()));
    }

    public record RawLatLon(double latitude, double longitude) { }

    private static FlightPosition toFlightPosition(LiveAircraft a) {
        return new FlightPosition(a.id(), a.icao24(), a.callsign(), a.observedAt(),
                a.displayLatitude(), a.displayLongitude(), a.altitudeM(), a.velocityMs(),
                a.headingDeg(), a.verticalRateMs(), a.onGround(), a.agentSource());
    }
}
