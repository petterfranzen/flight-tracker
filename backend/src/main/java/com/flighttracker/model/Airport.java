package com.flighttracker.model;

/**
 * Static ICAO-code reference data (name/municipality/country/coordinates),
 * seeded once from a bundled OurAirports CSV — see AirportSeedService.
 * Read-only in practice: nothing in the app ever writes to this table
 * except the one-time seed.
 *
 * Cloud migration A2: plain record, row-mapped by
 * repository.AirportRepository (JdbcClient), replacing the JPA @Entity
 * this used to be.
 */
public record Airport(
        String icaoCode,
        String iataCode,
        String name,
        String municipality,
        String country,
        Double latitude,
        Double longitude
) {
}
