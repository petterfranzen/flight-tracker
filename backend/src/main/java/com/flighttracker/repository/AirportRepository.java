package com.flighttracker.repository;

import com.flighttracker.model.Airport;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

import java.util.HashSet;
import java.util.Locale;
import java.util.Optional;
import java.util.Set;

/**
 * Cloud migration A2: JdbcClient + record, replacing the Spring Data JPA
 * repository this used to be.
 */
@Repository
public class AirportRepository {

    private final JdbcClient jdbcClient;

    public AirportRepository(JdbcClient jdbcClient) {
        this.jdbcClient = jdbcClient;
    }

    private static Airport mapRow(java.sql.ResultSet rs, int rowNum) throws java.sql.SQLException {
        return new Airport(
                rs.getString("icao_code"),
                rs.getString("iata_code"),
                rs.getString("name"),
                rs.getString("municipality"),
                rs.getString("country"),
                (Double) rs.getObject("latitude"),
                (Double) rs.getObject("longitude"));
    }

    public Optional<Airport> findById(String icaoCode) {
        return jdbcClient.sql("SELECT * FROM airport WHERE icao_code = :icaoCode")
                .param("icaoCode", icaoCode)
                .query(AirportRepository::mapRow)
                .optional();
    }

    // The map's own airport data (VectorBasemap's WORLD_AIRPORTS, from
    // Natural Earth) keys everything by IATA code, not the icao_code this
    // repository's id normally looks up by — this is what lets the airport
    // dossier resolve a click straight from that code.
    public Optional<Airport> findByIataCode(String iataCode) {
        return jdbcClient.sql("SELECT * FROM airport WHERE iata_code = :iataCode")
                .param("iataCode", iataCode)
                .query(AirportRepository::mapRow)
                .optional();
    }

    /**
     * ICAO codes of every airport whose ICAO/IATA code, name or
     * municipality contains {@code needle} (case-insensitive) — the airport
     * search resolves "Kalmar" to ESMQ once here, then matches live flights
     * against the codes in memory instead of one lookup per flight.
     */
    public Set<String> findIcaoCodesMatching(String needle) {
        String like = "%" + needle.toLowerCase(Locale.ROOT)
                .replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%";
        return new HashSet<>(jdbcClient.sql("""
                SELECT icao_code FROM airport
                WHERE LOWER(icao_code) LIKE :like ESCAPE '\\'
                   OR LOWER(COALESCE(iata_code, '')) LIKE :like ESCAPE '\\'
                   OR LOWER(name) LIKE :like ESCAPE '\\'
                   OR LOWER(COALESCE(municipality, '')) LIKE :like ESCAPE '\\'
                """)
                .param("like", like)
                .query(String.class)
                .list());
    }
}
