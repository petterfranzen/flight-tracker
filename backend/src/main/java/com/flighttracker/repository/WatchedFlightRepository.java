package com.flighttracker.repository;

import com.flighttracker.model.WatchedFlight;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Clock;
import java.time.LocalDate;
import java.util.List;
import java.util.Optional;

import static com.flighttracker.repository.Timestamps.fromEpochMilli;

/**
 * The watched_flight table (schema.sql, design §2), mirroring the frontend's
 * watchKey(w). `flight_date` is the board's Swedish local date as yyyy-MM-dd,
 * which sorts lexicographically exactly as it sorts chronologically — that is
 * what {@link #deleteBefore} relies on.
 */
@Repository
public class WatchedFlightRepository {

    private final JdbcClient jdbcClient;
    private final Clock clock;

    public WatchedFlightRepository(JdbcClient jdbcClient, Clock clock) {
        this.jdbcClient = jdbcClient;
        this.clock = clock;
    }

    private static WatchedFlight mapRow(ResultSet rs, int rowNum) throws SQLException {
        return new WatchedFlight(
                rs.getString("profile_id"),
                rs.getString("flight_number"),
                rs.getString("flight_date"),
                rs.getString("airport"),
                rs.getString("label"),
                fromEpochMilli(rs.getLong("updated_at")));
    }

    public List<WatchedFlight> findByProfileId(String profileId) {
        return jdbcClient.sql("""
                SELECT * FROM watched_flight WHERE profile_id = :profileId
                ORDER BY flight_date, flight_number, airport
                """)
                .param("profileId", profileId)
                .query(WatchedFlightRepository::mapRow)
                .list();
    }

    public Optional<WatchedFlight> find(String profileId, String flightNumber, String flightDate, String airport) {
        return jdbcClient.sql("""
                SELECT * FROM watched_flight
                WHERE profile_id = :profileId AND flight_number = :flightNumber
                  AND flight_date = :flightDate AND airport = :airport
                """)
                .param("profileId", profileId)
                .param("flightNumber", flightNumber)
                .param("flightDate", flightDate)
                .param("airport", airport)
                .query(WatchedFlightRepository::mapRow)
                .optional();
    }

    /** Adds or replaces one watched flight, stamping updated_at. */
    public void upsert(String profileId, String flightNumber, String flightDate, String airport, String label) {
        jdbcClient.sql("""
                INSERT INTO watched_flight
                    (profile_id, flight_number, flight_date, airport, label, updated_at)
                VALUES
                    (:profileId, :flightNumber, :flightDate, :airport, :label, :now)
                ON CONFLICT (profile_id, flight_number, flight_date, airport) DO UPDATE SET
                    label = excluded.label,
                    updated_at = excluded.updated_at
                """)
                .param("profileId", profileId)
                .param("flightNumber", flightNumber)
                .param("flightDate", flightDate)
                .param("airport", airport)
                .param("label", label)
                .param("now", clock.millis())
                .update();
    }

    public int delete(String profileId, String flightNumber, String flightDate, String airport) {
        return jdbcClient.sql("""
                DELETE FROM watched_flight
                WHERE profile_id = :profileId AND flight_number = :flightNumber
                  AND flight_date = :flightDate AND airport = :airport
                """)
                .param("profileId", profileId)
                .param("flightNumber", flightNumber)
                .param("flightDate", flightDate)
                .param("airport", airport)
                .update();
    }

    public int deleteAllForProfile(String profileId) {
        return jdbcClient.sql("DELETE FROM watched_flight WHERE profile_id = :profileId")
                .param("profileId", profileId)
                .update();
    }

    /**
     * Prunes rows whose board date is strictly before {@code cutoff} — the
     * flight is long gone, so the row is useless (design §2). Deletes by
     * {@code flight_date < cutoff} as text: yyyy-MM-dd compares lexicographically
     * the same as chronologically, and this small table needs no index for it.
     */
    public int deleteBefore(LocalDate cutoff) {
        return jdbcClient.sql("DELETE FROM watched_flight WHERE flight_date < :cutoff")
                .param("cutoff", cutoff.toString())
                .update();
    }
}
