package com.flighttracker.repository;

import com.flighttracker.service.enrichment.Route;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.util.List;

import static com.flighttracker.repository.Timestamps.fromEpochMilli;
import static com.flighttracker.repository.Timestamps.toEpochMilli;

/** The callsign_route table — see schema.sql and CallsignRouteService. */
@Repository
public class CallsignRouteRepository {

    /** One row: {@code route} is null when {@code found} is false (a confirmed miss). */
    public record Row(String callsign, boolean found, Route route, Instant fetchedAt) {
    }

    private final JdbcClient jdbcClient;

    public CallsignRouteRepository(JdbcClient jdbcClient) {
        this.jdbcClient = jdbcClient;
    }

    private static Row mapRow(ResultSet rs, int rowNum) throws SQLException {
        boolean found = rs.getInt("found") != 0;
        Route route = found
                ? new Route(
                        rs.getString("origin_airport"),
                        rs.getString("origin_airport_name"),
                        (Double) rs.getObject("origin_airport_lat"),
                        (Double) rs.getObject("origin_airport_lon"),
                        rs.getString("destination_airport"),
                        rs.getString("destination_airport_name"),
                        (Double) rs.getObject("destination_airport_lat"),
                        (Double) rs.getObject("destination_airport_lon"))
                : null;
        return new Row(rs.getString("callsign"), found, route, fromEpochMilli(rs.getLong("fetched_at")));
    }

    public List<Row> findAll() {
        return jdbcClient.sql("SELECT * FROM callsign_route").query(CallsignRouteRepository::mapRow).list();
    }

    public void upsert(String callsign, Route route, Instant fetchedAt) {
        jdbcClient.sql("""
                INSERT INTO callsign_route (callsign, found,
                    origin_airport, origin_airport_name, origin_airport_lat, origin_airport_lon,
                    destination_airport, destination_airport_name, destination_airport_lat, destination_airport_lon,
                    fetched_at)
                VALUES (:callsign, :found, :oa, :oan, :oalat, :oalon, :da, :dan, :dalat, :dalon, :fetchedAt)
                ON CONFLICT (callsign) DO UPDATE SET
                    found = excluded.found,
                    origin_airport = excluded.origin_airport,
                    origin_airport_name = excluded.origin_airport_name,
                    origin_airport_lat = excluded.origin_airport_lat,
                    origin_airport_lon = excluded.origin_airport_lon,
                    destination_airport = excluded.destination_airport,
                    destination_airport_name = excluded.destination_airport_name,
                    destination_airport_lat = excluded.destination_airport_lat,
                    destination_airport_lon = excluded.destination_airport_lon,
                    fetched_at = excluded.fetched_at
                """)
                .param("callsign", callsign)
                .param("found", route != null ? 1 : 0)
                .param("oa", route == null ? null : route.originAirport())
                .param("oan", route == null ? null : route.originAirportName())
                .param("oalat", route == null ? null : route.originAirportLat())
                .param("oalon", route == null ? null : route.originAirportLon())
                .param("da", route == null ? null : route.destinationAirport())
                .param("dan", route == null ? null : route.destinationAirportName())
                .param("dalat", route == null ? null : route.destinationAirportLat())
                .param("dalon", route == null ? null : route.destinationAirportLon())
                .param("fetchedAt", toEpochMilli(fetchedAt))
                .update();
    }
}
