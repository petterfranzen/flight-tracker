package com.flighttracker.repository;

import com.flighttracker.model.Aircraft;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Clock;
import java.time.Instant;
import java.util.Collection;
import java.util.List;
import java.util.Optional;

import static com.flighttracker.repository.Timestamps.fromEpochMilli;
import static com.flighttracker.repository.Timestamps.toEpochMilli;

/**
 * Cloud migration A2: JdbcClient + record, replacing the Spring Data JPA
 * repository this used to be. Aircraft is immutable now (see its own
 * javadoc), so the old load-mutate-save pattern AircraftEnrichmentService
 * used is gone — updateEnrichment/updateLandingCheck below issue a
 * targeted UPDATE directly instead.
 */
@Repository
public class AircraftRepository {

    private final JdbcClient jdbcClient;
    private final Clock clock;

    public AircraftRepository(JdbcClient jdbcClient, Clock clock) {
        this.jdbcClient = jdbcClient;
        this.clock = clock;
    }

    private static Aircraft mapRow(ResultSet rs, int rowNum) throws SQLException {
        return new Aircraft(
                rs.getString("icao24"),
                rs.getString("registration"),
                rs.getString("model"),
                rs.getString("operator"),
                rs.getString("origin_airport"),
                rs.getString("origin_airport_name"),
                rs.getString("destination_airport"),
                rs.getString("destination_airport_name"),
                (Double) rs.getObject("origin_airport_lat"),
                (Double) rs.getObject("origin_airport_lon"),
                (Double) rs.getObject("destination_airport_lat"),
                (Double) rs.getObject("destination_airport_lon"),
                fromEpochMilli((Long) rs.getObject("metadata_fetched_at")),
                fromEpochMilli((Long) rs.getObject("landing_check_observed_at")),
                fromEpochMilli((Long) rs.getObject("landing_confirmed_at")),
                fromEpochMilli(rs.getLong("first_seen_at")),
                fromEpochMilli(rs.getLong("last_seen_at")));
    }

    public Optional<Aircraft> findById(String icao24) {
        return jdbcClient.sql("SELECT * FROM aircraft WHERE icao24 = :icao24")
                .param("icao24", icao24)
                .query(AircraftRepository::mapRow)
                .optional();
    }

    public List<Aircraft> findAllById(Collection<String> icao24s) {
        if (icao24s.isEmpty()) return List.of();
        return jdbcClient.sql("SELECT * FROM aircraft WHERE icao24 IN (:icao24s)")
                .param("icao24s", icao24s)
                .query(AircraftRepository::mapRow)
                .list();
    }

    public boolean existsById(String icao24) {
        return jdbcClient.sql("SELECT 1 FROM aircraft WHERE icao24 = :icao24")
                .param("icao24", icao24)
                .query(Integer.class)
                .optional()
                .isPresent();
    }

    /**
     * Insert-if-absent — same DO NOTHING semantics as
     * PositionPersistenceService's batched AIRCRAFT_UPSERT_SQL (that one
     * stays as-is; this is the equivalent for the hot-poll's per-report
     * path, which needs to know whether the aircraft was newly seen at all
     * to decide whether to trigger enrichment — see
     * PositionPersistenceService.persist()).
     *
     * @return true if this call actually inserted a new row (a genuinely
     *         new aircraft); false if it already existed.
     */
    public boolean insertIfAbsent(String icao24) {
        long now = clock.millis();
        int rows = jdbcClient.sql("""
                INSERT INTO aircraft (icao24, first_seen_at, last_seen_at)
                VALUES (:icao24, :now, :now)
                ON CONFLICT (icao24) DO NOTHING
                """)
                .param("icao24", icao24)
                .param("now", now)
                .update();
        return rows > 0;
    }

    /**
     * Targeted dossier-field update, replacing the old load-a-JPA-entity/
     * mutate-fields/save() pattern (see AircraftEnrichmentService.doEnrich).
     * Each nullable parameter is only written when non-null (COALESCE
     * against the existing column) — same semantics as the old code's
     * {@code info.ifPresent(...)}/{@code route.ifPresent(...)} conditional
     * field sets: a lookup that found nothing leaves those columns
     * untouched rather than clobbering them with null.
     * metadataFetchedAt is unconditional: set every call, same as before,
     * to mark the lookup as "tried" regardless of whether it found
     * anything.
     */
    public void updateEnrichment(String icao24,
                                  String model, String registration, String operator,
                                  String originAirport, String originAirportName,
                                  Double originAirportLat, Double originAirportLon,
                                  String destinationAirport, String destinationAirportName,
                                  Double destinationAirportLat, Double destinationAirportLon,
                                  Instant metadataFetchedAt) {
        jdbcClient.sql("""
                UPDATE aircraft SET
                    model = COALESCE(:model, model),
                    registration = COALESCE(:registration, registration),
                    operator = COALESCE(:operator, operator),
                    origin_airport = COALESCE(:originAirport, origin_airport),
                    origin_airport_name = COALESCE(:originAirportName, origin_airport_name),
                    origin_airport_lat = COALESCE(:originAirportLat, origin_airport_lat),
                    origin_airport_lon = COALESCE(:originAirportLon, origin_airport_lon),
                    destination_airport = COALESCE(:destinationAirport, destination_airport),
                    destination_airport_name = COALESCE(:destinationAirportName, destination_airport_name),
                    destination_airport_lat = COALESCE(:destinationAirportLat, destination_airport_lat),
                    destination_airport_lon = COALESCE(:destinationAirportLon, destination_airport_lon),
                    metadata_fetched_at = :metadataFetchedAt
                WHERE icao24 = :icao24
                """)
                .param("model", model)
                .param("registration", registration)
                .param("operator", operator)
                .param("originAirport", originAirport)
                .param("originAirportName", originAirportName)
                .param("originAirportLat", originAirportLat)
                .param("originAirportLon", originAirportLon)
                .param("destinationAirport", destinationAirport)
                .param("destinationAirportName", destinationAirportName)
                .param("destinationAirportLat", destinationAirportLat)
                .param("destinationAirportLon", destinationAirportLon)
                .param("metadataFetchedAt", toEpochMilli(metadataFetchedAt))
                .param("icao24", icao24)
                .update();
    }

    public void updateLandingCheck(String icao24, Instant landingCheckObservedAt, Instant landingConfirmedAt) {
        jdbcClient.sql("""
                UPDATE aircraft SET landing_check_observed_at = :checkedAt, landing_confirmed_at = :confirmedAt
                WHERE icao24 = :icao24
                """)
                .param("checkedAt", toEpochMilli(landingCheckObservedAt))
                .param("confirmedAt", toEpochMilli(landingConfirmedAt))
                .param("icao24", icao24)
                .update();
    }

    /**
     * Retention (PositionRetentionService, PLAN.md §6 item 6): deletes
     * aircraft rows not seen for 7 days with no remaining flight_position
     * rows — companion to that service's own flight_position pruning, so
     * `aircraft` doesn't accumulate forever for aircraft that have long
     * since aged out of any real history. "Not seen" means first_seen_at
     * older than the cutoff (last_seen_at is no longer bumped after
     * creation — see this table's own schema.sql comment), "no remaining
     * positions" is the NOT EXISTS guard, so an aircraft with recent
     * history is never deleted just because it's old.
     */
    public int deleteStaleWithNoPositions(Instant cutoff) {
        return jdbcClient.sql("""
                DELETE FROM aircraft
                WHERE first_seen_at < :cutoff
                  AND NOT EXISTS (SELECT 1 FROM flight_position fp WHERE fp.icao24 = aircraft.icao24)
                """)
                .param("cutoff", toEpochMilli(cutoff))
                .update();
    }
}
