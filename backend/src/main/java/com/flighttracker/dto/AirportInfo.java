package com.flighttracker.dto;

/**
 * Static reference details for one airport — the map's airport dossier
 * panel, opened by clicking an airport's dot (see AirportController).
 * Distinct from AirportGatesController's gate/apron/terminal geometry:
 * this is the `airport` reference table's own descriptive fields, not
 * anything fetched live from OpenStreetMap.
 */
public record AirportInfo(
        String icaoCode,
        String iataCode,
        String name,
        String municipality,
        String country,
        Double latitude,
        Double longitude) {
}
