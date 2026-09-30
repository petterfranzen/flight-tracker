package com.flighttracker.repository;

import com.flighttracker.model.FlightPosition;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Clock;
import java.time.Instant;
import java.util.List;
import java.util.Optional;

import static com.flighttracker.repository.Timestamps.fromEpochMilli;
import static com.flighttracker.repository.Timestamps.toEpochMilli;

/**
 * flight_position only — the append-only history table. Everything that
 * used to live here reading/writing aircraft_latest_position (the "latest
 * per aircraft" summary table) moved to LiveStateStore (service/live/) as
 * part of cloud migration A1 — see that class's own javadoc. This
 * repository still backs the things only flight_position's real history
 * can answer: dedup-on-insert, leg/altitude lookups for the dossier, and
 * the usage report's raw window reads.
 *
 * Cloud migration A2: JdbcClient + record, replacing the Spring Data JPA
 * repository this used to be. The one exception is PositionPersistenceService.
 * persistBatch's ~13k-row global-sweep insert, which stays on raw
 * JdbcTemplate.batchUpdate — JdbcClient's fluent single-statement API has
 * no batching primitive, and that path was never routed through this
 * repository interface even before A2 (see PositionPersistenceService's
 * own class javadoc).
 */
@Repository
public class FlightPositionRepository {

    private final JdbcClient jdbcClient;
    private final Clock clock;

    public FlightPositionRepository(JdbcClient jdbcClient, Clock clock) {
        this.jdbcClient = jdbcClient;
        this.clock = clock;
    }

    private static FlightPosition mapRow(ResultSet rs, int rowNum) throws SQLException {
        return new FlightPosition(
                rs.getLong("id"),
                rs.getString("icao24"),
                rs.getString("callsign"),
                fromEpochMilli(rs.getLong("observed_at")),
                rs.getDouble("latitude"),
                rs.getDouble("longitude"),
                (Double) rs.getObject("altitude_m"),
                (Double) rs.getObject("velocity_ms"),
                (Double) rs.getObject("heading_deg"),
                (Double) rs.getObject("vertical_rate_ms"),
                rs.getInt("on_ground") != 0,
                rs.getString("agent_source"));
    }

    // Two agents (or two poll cycles of the same agent, when OpenSky hasn't
    // refreshed an aircraft between our polls) can report the exact same
    // (icao24, observed_at, agent_source) tick. ON CONFLICT DO NOTHING
    // sidesteps that entirely — the duplicate is a no-op at the SQL level,
    // not an error. RETURNING * (supported natively since SQLite 3.35) is
    // what lets the caller tell "inserted" apart from "duplicate, skipped"
    // without a second round trip.
    public Optional<FlightPosition> insertIgnoringDuplicate(
            String icao24, String callsign, Instant observedAt,
            double latitude, double longitude, Double altitudeM,
            Double velocityMs, Double headingDeg, Double verticalRateMs,
            boolean onGround, String agentSource) {
        return jdbcClient.sql("""
                INSERT INTO flight_position
                    (icao24, callsign, observed_at, latitude, longitude, altitude_m,
                     velocity_ms, heading_deg, vertical_rate_ms, on_ground, agent_source, inserted_at)
                VALUES
                    (:icao24, :callsign, :observedAt, :latitude, :longitude, :altitudeM,
                     :velocityMs, :headingDeg, :verticalRateMs, :onGround, :agentSource, :insertedAt)
                ON CONFLICT (icao24, observed_at, agent_source) DO NOTHING
                RETURNING *
                """)
                .param("icao24", icao24)
                .param("callsign", callsign)
                .param("observedAt", toEpochMilli(observedAt))
                .param("latitude", latitude)
                .param("longitude", longitude)
                .param("altitudeM", altitudeM)
                .param("velocityMs", velocityMs)
                .param("headingDeg", headingDeg)
                .param("verticalRateMs", verticalRateMs)
                .param("onGround", onGround ? 1 : 0)
                .param("agentSource", agentSource)
                .param("insertedAt", clock.millis())
                .query(FlightPositionRepository::mapRow)
                .optional();
    }

    // "Current flight time" for the dossier (AircraftController) — this
    // leg's takeoff time, not the first time we ever saw the aircraft.
    // "This leg" means the most recent one, whether still airborne or
    // already landed again: the takeoff moment immediately following the
    // last time this aircraft was genuinely on the ground beforehand.
    //
    // Found as the most recent ground->air *transition*, via LAG() over
    // this aircraft's own chronological history: a row is a takeoff moment
    // when it's airborne and the row immediately before it either doesn't
    // exist (prev_on_ground IS NULL — the very first report we ever have)
    // or was on the ground (prev_on_ground != 0). IS NOT (... IS ...) is
    // the null-safe way to ask "prev_on_ground isn't exactly 0" — SQLite
    // has no IS DISTINCT FROM, but `x IS NOT 0` is already null-safe by
    // definition of SQLite's IS operator (NULL IS NOT 0 evaluates true).
    public Optional<Instant> findCurrentLegTakeoffTime(String icao24) {
        return jdbcClient.sql("""
                SELECT observed_at
                FROM (
                    SELECT observed_at, on_ground,
                           LAG(on_ground) OVER (ORDER BY observed_at) AS prev_on_ground
                    FROM flight_position
                    WHERE icao24 = :icao24
                ) transitions
                WHERE on_ground = 0
                  AND prev_on_ground IS NOT 0
                ORDER BY observed_at DESC
                LIMIT 1
                """)
                .param("icao24", icao24)
                .query(Long.class)
                .optional()
                .map(Timestamps::fromEpochMilli);
    }

    // "Cruising altitude" for the dossier: the highest altitude reached so
    // far in the current leg (from legStart, i.e. findCurrentLegTakeoffTime
    // above). Still meaningful after landing (it's simply that completed
    // flight's peak), so this isn't gated on on_ground.
    public Optional<Double> findMaxAltitudeSince(String icao24, Instant legStart) {
        return jdbcClient.sql("SELECT MAX(altitude_m) FROM flight_position WHERE icao24 = :icao24 AND observed_at >= :legStart")
                .param("icao24", icao24)
                .param("legStart", toEpochMilli(legStart))
                .query(Double.class)
                .optional();
    }

    // The other input FlightPhaseClassifier needs: altitude at an earlier
    // reference point, to turn into a real trend rather than reading the
    // single latest (possibly noisy) vertical_rate_ms in isolation.
    // Bounded to >= legStart so a short-on-data early flight falls back to
    // "no earlier point yet" (empty) rather than reaching into a previous,
    // unrelated leg.
    public Optional<Double> findAltitudeAtOrBefore(String icao24, Instant legStart, Instant atOrBefore) {
        return jdbcClient.sql("""
                SELECT altitude_m
                FROM flight_position
                WHERE icao24 = :icao24 AND observed_at >= :legStart AND observed_at <= :atOrBefore
                ORDER BY observed_at DESC
                LIMIT 1
                """)
                .param("icao24", icao24)
                .param("legStart", toEpochMilli(legStart))
                .param("atOrBefore", toEpochMilli(atOrBefore))
                .query(Double.class)
                .optional();
    }

    // Usage calc: full ordered history for one aircraft in a window.
    public List<FlightPosition> findByIcao24AndObservedAtBetween(String icao24, Instant from, Instant to) {
        return jdbcClient.sql("""
                SELECT * FROM flight_position
                WHERE icao24 = :icao24 AND observed_at BETWEEN :from AND :to
                ORDER BY observed_at ASC
                """)
                .param("icao24", icao24)
                .param("from", toEpochMilli(from))
                .param("to", toEpochMilli(to))
                .query(FlightPositionRepository::mapRow)
                .list();
    }

    // Usage calc: history for every aircraft in a window, for the fleet report.
    public List<FlightPosition> findByObservedAtBetween(Instant from, Instant to) {
        return jdbcClient.sql("""
                SELECT * FROM flight_position
                WHERE observed_at BETWEEN :from AND :to
                ORDER BY icao24 ASC, observed_at ASC
                """)
                .param("from", toEpochMilli(from))
                .param("to", toEpochMilli(to))
                .query(FlightPositionRepository::mapRow)
                .list();
    }
}
