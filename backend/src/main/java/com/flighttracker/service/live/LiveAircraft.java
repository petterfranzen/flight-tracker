package com.flighttracker.service.live;

import java.time.Instant;

/**
 * In-memory equivalent of one aircraft_latest_position row — see
 * LiveStateStore's own javadoc for why this table moved into memory.
 * Immutable: every LiveStateStore write replaces the map's entry with a new
 * instance rather than mutating fields in place, which is what lets
 * ConcurrentHashMap.compute's per-key locking be the only synchronization
 * this needs (a reader that got a reference to one of these before a
 * concurrent update never sees a half-written row).
 *
 * id is a synthetic, in-process-only sequence — the DB row this replaces
 * had a real BIGSERIAL id (assigned once, on first insert, then carried
 * forward unchanged by every later ON CONFLICT DO UPDATE for that icao24);
 * this reproduces exactly that "assigned once per aircraft, stable for its
 * lifetime in the live set" behaviour without a database to generate it,
 * purely so FlightPosition's existing id field (part of its established
 * JSON shape — see /api/flights/{icao24}/live and /api/flights/search)
 * keeps serializing a stable, present value rather than becoming null.
 *
 * estimatedLatitude/estimatedLongitude/estimatedAt mirror
 * aircraft_latest_position's own estimated_* columns exactly — see that
 * table's schema.sql comment for why they're separate fields rather than
 * overwriting latitude/longitude directly. displayLatitude/displayLongitude
 * are the COALESCE(estimated_*, ...) every DB reader used to apply
 * (FlightPositionRepository.LATEST_COLUMNS) — now just a plain Java
 * ternary, since there's no SQL expression to keep in sync across queries
 * any more.
 */
public record LiveAircraft(
        long id,
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
        String agentSource,
        Instant landedSince,
        Double estimatedLatitude,
        Double estimatedLongitude,
        Instant estimatedAt
) {
    public double displayLatitude() {
        return estimatedLatitude != null ? estimatedLatitude : latitude;
    }

    public double displayLongitude() {
        return estimatedLongitude != null ? estimatedLongitude : longitude;
    }
}
