package com.flighttracker.model;

import java.time.Instant;

/**
 * One row of the watched_flight table (schema.sql), mirroring the frontend's
 * watchKey(w): (profile_id, flight_number, flight_date, airport).
 * `flightDate` is the board's Swedish local date, yyyy-MM-dd, which is what
 * PositionRetentionService's 7-day prune compares against.
 */
public record WatchedFlight(
        String profileId,
        String flightNumber,
        String flightDate,
        String airport,
        String label,
        Instant updatedAt
) {
}
