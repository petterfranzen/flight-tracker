package com.flighttracker.dto;

/**
 * Static reference details for one airport — the map's airport dossier
 * panel, opened by clicking an airport's dot (see AirportController).
 * The `airport` reference table's own descriptive fields — nothing here
 * is fetched live. Gate/apron/terminal *geometry* used to be a sibling
 * endpoint proxying Overpass; it now comes from the map's vector tiles
 * instead (see AirportController).
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
