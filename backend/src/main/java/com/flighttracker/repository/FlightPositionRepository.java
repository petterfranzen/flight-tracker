package com.flighttracker.repository;

import com.flighttracker.model.FlightPosition;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.time.Instant;
import java.util.List;
import java.util.Optional;

public interface FlightPositionRepository extends JpaRepository<FlightPosition, Long> {

    // Live map: most recent report per aircraft seen in the last N minutes.
    @Query(value = """
        SELECT DISTINCT ON (icao24) *
        FROM flight_position
        WHERE observed_at > :since
        ORDER BY icao24, observed_at DESC
        """, nativeQuery = true)
    List<FlightPosition> findLatestPerAircraftSince(@Param("since") Instant since);

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
