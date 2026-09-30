package com.flighttracker.model;

import java.time.Instant;

/**
 * One historic position report. Rows are never updated — the usage service
 * derives distance/airtime by walking consecutive rows for an aircraft.
 *
 * Cloud migration A2: plain Java record, row-mapped by
 * repository.FlightPositionRepository (JdbcClient), replacing the JPA
 * @Entity this used to be. Jackson serializes a record's components under
 * their own names with no extra configuration (Jackson 2.12+), so this
 * keeps producing the exact same JSON shape as before (id, icao24,
 * callsign, observedAt, latitude, longitude, altitudeM, velocityMs,
 * headingDeg, verticalRateMs, onGround, agentSource) for every endpoint
 * that returns it directly (/api/flights/search, /api/flights/{icao24}/
 * live, /api/flights/{icao24}/history).
 */
public record FlightPosition(
        Long id,
        String icao24,
        String callsign,
        Instant observedAt,
        double latitude,
        double longitude,
        Double altitudeM,
        Double velocityMs,
        Double headingDeg,
        Double verticalRateMs,
        boolean onGround,
        String agentSource
) {
    /**
     * Same fields, no id — for constructing a position that either hasn't
     * been persisted yet or, for LiveStateStore's coalesced views, never
     * will be as its own row (see LiveAircraft's javadoc). Most in-memory
     * construction across the codebase (EstimatedPositionService, tests)
     * uses this: it genuinely doesn't have or need a database id.
     */
    public FlightPosition(String icao24, String callsign, Instant observedAt,
                           double latitude, double longitude, Double altitudeM,
                           Double velocityMs, Double headingDeg, Double verticalRateMs,
                           boolean onGround, String agentSource) {
        this(null, icao24, callsign, observedAt, latitude, longitude, altitudeM,
                velocityMs, headingDeg, verticalRateMs, onGround, agentSource);
    }

    /**
     * A copy of this position with latitude/longitude replaced — used by
     * EstimatedPositionService to dead-reckon a stale report forward
     * without ever mutating the original. Every other field, including
     * observedAt and id, carries over unchanged: the copy is
     * indistinguishable in shape from a real report, deliberately — see
     * EstimatorAgent's javadoc for why the frontend is never told which is
     * which. This in-memory copy itself is never persisted as a row —
     * EstimatorAgent only takes its latitude/longitude back out to write
     * into LiveStateStore's separate estimatedLatitude/estimatedLongitude
     * fields, never into flight_position.
     */
    public FlightPosition withEstimatedPosition(double latitude, double longitude) {
        return new FlightPosition(id, icao24, callsign, observedAt, latitude, longitude,
                altitudeM, velocityMs, headingDeg, verticalRateMs, onGround, agentSource);
    }
}
