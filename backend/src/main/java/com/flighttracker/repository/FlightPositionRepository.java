package com.flighttracker.repository;

import com.flighttracker.model.FlightPosition;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.time.Instant;
import java.util.List;
import java.util.Optional;

public interface FlightPositionRepository extends JpaRepository<FlightPosition, Long> {

    // Live map: each aircraft's latest known position, included if it's
    // still airborne (bounded by staleAirborneCutoff so a truly dead/never-
    // updating icao24 doesn't linger forever — real ADS-B gaps happen, but
    // an aircraft silent for that long is presumed lost from the feed, not
    // still flying) or if it landed within the last landedCutoff window.
    // "Landed since" is the earliest on_ground=true report since the last
    // time that aircraft was seen airborne (or, if it's never been seen
    // airborne in retained history, its earliest report at all) — i.e. the
    // start of its current landed streak.
    @Query(value = """
        WITH latest AS (
            SELECT DISTINCT ON (icao24) *
            FROM flight_position
            ORDER BY icao24, observed_at DESC
        ),
        landed_since AS (
            SELECT l.icao24, MIN(fp.observed_at) AS since
            FROM latest l
            JOIN flight_position fp ON fp.icao24 = l.icao24 AND fp.on_ground = true
            LEFT JOIN LATERAL (
                SELECT MAX(observed_at) AS last_airborne_at
                FROM flight_position
                WHERE icao24 = l.icao24 AND on_ground = false
            ) la ON true
            WHERE l.on_ground = true
              AND (la.last_airborne_at IS NULL OR fp.observed_at > la.last_airborne_at)
            GROUP BY l.icao24
        )
        SELECT latest.*
        FROM latest
        LEFT JOIN landed_since ON landed_since.icao24 = latest.icao24
        WHERE (latest.on_ground = false AND latest.observed_at > :staleAirborneCutoff)
           OR (latest.on_ground = true AND landed_since.since > :landedCutoff)
        """, nativeQuery = true)
    List<FlightPosition> findLive(@Param("staleAirborneCutoff") Instant staleAirborneCutoff,
                                   @Param("landedCutoff") Instant landedCutoff);

    // Two agents (or two poll cycles of the same agent, when OpenSky hasn't
    // refreshed an aircraft between our polls) can report the exact same
    // (icao24, observed_at, agent_source) tick. A plain save() that relies
    // on catching the resulting DataIntegrityViolationException doesn't
    // work here: Postgres aborts the *whole* transaction on a constraint
    // violation, not just the offending statement, so catching it in Java
    // after the fact still leaves every later save() in the same batch
    // failing too. ON CONFLICT DO NOTHING sidesteps that entirely — the
    // duplicate is a no-op at the SQL level, not an error.
    @Query(value = """
        INSERT INTO flight_position
            (icao24, callsign, observed_at, latitude, longitude, altitude_m,
             velocity_ms, heading_deg, vertical_rate_ms, on_ground, agent_source)
        VALUES
            (:icao24, :callsign, :observedAt, :latitude, :longitude, :altitudeM,
             :velocityMs, :headingDeg, :verticalRateMs, :onGround, :agentSource)
        ON CONFLICT (icao24, observed_at, agent_source) DO NOTHING
        RETURNING *
        """, nativeQuery = true)
    Optional<FlightPosition> insertIgnoringDuplicate(
            @Param("icao24") String icao24,
            @Param("callsign") String callsign,
            @Param("observedAt") Instant observedAt,
            @Param("latitude") double latitude,
            @Param("longitude") double longitude,
            @Param("altitudeM") Double altitudeM,
            @Param("velocityMs") Double velocityMs,
            @Param("headingDeg") Double headingDeg,
            @Param("verticalRateMs") Double verticalRateMs,
            @Param("onGround") boolean onGround,
            @Param("agentSource") String agentSource);

    // Usage calc: full ordered history for one aircraft in a window.
    List<FlightPosition> findByIcao24AndObservedAtBetweenOrderByObservedAtAsc(
            String icao24, Instant from, Instant to);

    // Usage calc: history for every aircraft in a window, for the fleet report.
    List<FlightPosition> findByObservedAtBetweenOrderByIcao24AscObservedAtAsc(
            Instant from, Instant to);
}
