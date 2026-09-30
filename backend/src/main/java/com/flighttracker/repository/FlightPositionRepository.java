package com.flighttracker.repository;

import com.flighttracker.model.FlightPosition;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.time.Instant;
import java.util.List;
import java.util.Optional;

/**
 * flight_position only — the append-only history table. Everything that
 * used to live here reading/writing aircraft_latest_position (the "latest
 * per aircraft" summary table) moved to LiveStateStore (service/live/) as
 * part of the cloud migration's consolidation to one in-process live-state
 * map — see that class's own javadoc. This repository still backs the
 * things only flight_position's real history can answer: dedup-on-insert,
 * leg/altitude lookups for the dossier, and the usage report's raw window
 * reads.
 */
public interface FlightPositionRepository extends JpaRepository<FlightPosition, Long> {

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

    // "Current flight time" for the dossier (AircraftController) — this
    // leg's takeoff time, not the first time we ever saw the aircraft.
    // "This leg" means the most recent one, whether still airborne or
    // already landed again: the takeoff moment immediately following the
    // last time this aircraft was genuinely on the ground beforehand.
    //
    // Found as the most recent ground→air *transition*, via LAG() over
    // this aircraft's own chronological history: a row is a takeoff moment
    // when it's airborne and the row immediately before it either doesn't
    // exist (prev_on_ground IS NULL — the very first report we ever have,
    // handled the same as the old query's epoch-floor fallback for an
    // aircraft we've only ever seen airborne) or was on the ground
    // (prev_on_ground = true). IS DISTINCT FROM is the null-safe way to
    // ask "prev_on_ground isn't exactly false" — a plain <> would silently
    // drop the NULL case instead of matching it.
    //
    // A prior version of this query instead looked for "the earliest
    // airborne report after this aircraft's own most recent on-ground
    // report" — which breaks the instant the aircraft lands again: at that
    // point its own most-recent report *is* that on-ground one, so
    // "airborne reports after it" is trivially empty, and the query
    // silently returned nothing for any landed aircraft. That emptiness
    // then skipped /history's leg-trimming entirely on the frontend
    // (FlightMap.tsx's legStartAtRef), so a landed aircraft's route line
    // showed its full unfiltered 6-hour lookback instead of just this leg
    // — concatenating in whatever earlier, unrelated flight happened to
    // fall in that window. The LAG()-based transition search below gives
    // the same answer whether the aircraft is still airborne or has since
    // landed, since it isn't self-referential against the aircraft's own
    // current state.
    @Query(value = """
        SELECT observed_at
        FROM (
            SELECT observed_at, on_ground,
                   LAG(on_ground) OVER (ORDER BY observed_at) AS prev_on_ground
            FROM flight_position
            WHERE icao24 = :icao24
        ) transitions
        WHERE on_ground = false
          AND prev_on_ground IS DISTINCT FROM false
        ORDER BY observed_at DESC
        LIMIT 1
        """, nativeQuery = true)
    Optional<Instant> findCurrentLegTakeoffTime(@Param("icao24") String icao24);

    // "Cruising altitude" for the dossier: the highest altitude reached so
    // far in the current leg (from legStart, i.e. findCurrentLegTakeoffTime
    // above — not this aircraft's entire tracked history, which could span
    // many separate flights). Still meaningful after landing (it's simply
    // that completed flight's peak), so this isn't gated on on_ground.
    @Query(value = "SELECT MAX(altitude_m) FROM flight_position WHERE icao24 = :icao24 AND observed_at >= :legStart",
            nativeQuery = true)
    Optional<Double> findMaxAltitudeSince(@Param("icao24") String icao24, @Param("legStart") Instant legStart);

    // The other input FlightPhaseClassifier needs: altitude at an earlier
    // reference point, to turn into a real trend rather than reading the
    // single latest (possibly noisy) vertical_rate_ms in isolation.
    // Bounded to >= legStart so a short-on-data early flight falls back to
    // "no earlier point yet" (null) rather than reaching back into a
    // previous, unrelated flight leg from this aircraft's older history.
    @Query(value = """
        SELECT altitude_m
        FROM flight_position
        WHERE icao24 = :icao24 AND observed_at >= :legStart AND observed_at <= :atOrBefore
        ORDER BY observed_at DESC
        LIMIT 1
        """, nativeQuery = true)
    Optional<Double> findAltitudeAtOrBefore(@Param("icao24") String icao24,
                                             @Param("legStart") Instant legStart,
                                             @Param("atOrBefore") Instant atOrBefore);

    // Usage calc: full ordered history for one aircraft in a window.
    List<FlightPosition> findByIcao24AndObservedAtBetweenOrderByObservedAtAsc(
            String icao24, Instant from, Instant to);

    // Usage calc: history for every aircraft in a window, for the fleet report.
    List<FlightPosition> findByObservedAtBetweenOrderByIcao24AscObservedAtAsc(
            Instant from, Instant to);
}
