package com.flighttracker.repository;

import com.flighttracker.model.FlightPosition;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.time.Instant;
import java.util.List;
import java.util.Optional;

public interface FlightPositionRepository extends JpaRepository<FlightPosition, Long> {

    // aircraft_latest_position's columns, explicitly listed (not SELECT *)
    // so the extra landed_since column never leaks into FlightPosition's
    // entity mapping, which doesn't have a field for it.
    String LATEST_COLUMNS = """
        id, icao24, callsign, observed_at, latitude, longitude, altitude_m,
        velocity_ms, heading_deg, vertical_rate_ms, on_ground, agent_source
        """;

    // Live map, whole world: every aircraft that's still airborne (bounded
    // by staleAirborneCutoff so a truly dead/never-updating icao24 doesn't
    // linger forever — real ADS-B gaps happen, but an aircraft silent that
    // long is presumed lost from the feed, not still flying) or landed
    // within the last landedCutoff window. See aircraft_latest_position's
    // schema.sql comment for why this reads a maintained summary table
    // instead of aggregating flight_position's full history on every call.
    @Query(value = "SELECT " + LATEST_COLUMNS + """
        FROM aircraft_latest_position
        WHERE (on_ground = false AND observed_at > :staleAirborneCutoff)
           OR (on_ground = true AND landed_since > :landedCutoff)
        """, nativeQuery = true)
    List<FlightPosition> findLive(@Param("staleAirborneCutoff") Instant staleAirborneCutoff,
                                   @Param("landedCutoff") Instant landedCutoff);

    // Same as findLive, further filtered to a lat/lon box — what the
    // frontend actually calls with, passing its current map viewport, so
    // only what's visible is fetched/rendered rather than every aircraft
    // being globally tracked.
    @Query(value = "SELECT " + LATEST_COLUMNS + """
        FROM aircraft_latest_position
        WHERE ((on_ground = false AND observed_at > :staleAirborneCutoff)
           OR (on_ground = true AND landed_since > :landedCutoff))
          AND latitude BETWEEN :latMin AND :latMax
          AND longitude BETWEEN :lonMin AND :lonMax
        """, nativeQuery = true)
    List<FlightPosition> findLiveInBounds(@Param("staleAirborneCutoff") Instant staleAirborneCutoff,
                                           @Param("landedCutoff") Instant landedCutoff,
                                           @Param("latMin") double latMin,
                                           @Param("latMax") double latMax,
                                           @Param("lonMin") double lonMin,
                                           @Param("lonMax") double lonMax);

    // Keeps aircraft_latest_position in sync — called once per accepted
    // (non-duplicate) flight_position insert, i.e. right after
    // insertIgnoringDuplicate returns a present Optional. The WHERE guard
    // on the UPDATE only lets a report move the row *forward* in time —
    // reports can arrive slightly out of order (two agents, network
    // delays) and this must never regress "latest" to something older.
    // landed_since: reset to this report's time the moment on_ground flips
    // true, carried forward unchanged while it stays true, cleared on the
    // next false.
    @Modifying
    @Query(value = """
        INSERT INTO aircraft_latest_position
            (icao24, callsign, observed_at, latitude, longitude, altitude_m,
             velocity_ms, heading_deg, vertical_rate_ms, on_ground, agent_source, landed_since)
        VALUES
            (:icao24, :callsign, :observedAt, :latitude, :longitude, :altitudeM,
             :velocityMs, :headingDeg, :verticalRateMs, :onGround, :agentSource,
             CASE WHEN :onGround THEN CAST(:observedAt AS timestamptz) ELSE NULL END)
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
            END
        WHERE EXCLUDED.observed_at > aircraft_latest_position.observed_at
        """, nativeQuery = true)
    void upsertLatestPosition(
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

    // On-demand enrichment (AircraftController) needs a callsign to key
    // adsbdb's route lookup by — aircraft_latest_position is the cheap way
    // to get one without touching flight_position's full history.
    @Query(value = "SELECT callsign FROM aircraft_latest_position WHERE icao24 = :icao24", nativeQuery = true)
    Optional<String> findLatestCallsign(@Param("icao24") String icao24);

    // Lets AgentOrchestrator tell a genuinely first-ever boot (empty table,
    // worth blocking startup on one synchronous global sweep so the map
    // isn't empty) apart from every later restart (table already has
    // *some* data, even if a few minutes stale — not worth adding tens of
    // seconds to every redeploy for).
    @Query(value = "SELECT count(*) FROM aircraft_latest_position", nativeQuery = true)
    long countLatestPositions();

    // Usage calc: full ordered history for one aircraft in a window.
    List<FlightPosition> findByIcao24AndObservedAtBetweenOrderByObservedAtAsc(
            String icao24, Instant from, Instant to);

    // Usage calc: history for every aircraft in a window, for the fleet report.
    List<FlightPosition> findByObservedAtBetweenOrderByIcao24AscObservedAtAsc(
            Instant from, Instant to);
}
