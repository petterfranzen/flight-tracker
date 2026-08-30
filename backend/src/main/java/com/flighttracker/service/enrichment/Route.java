package com.flighttracker.service.enrichment;

/**
 * Origin/destination for an aircraft's most recent flight leg. The ICAO
 * codes are always attempted; the full names and coordinates are only
 * available from adsbdb's callsign lookup — the OpenSky fallback (bare
 * estimated-airport codes, no name/coordinate data) leaves those fields
 * null. Coordinates are what makes ETA computable — see AircraftController.
 */
public record Route(String originAirport, String originAirportName, Double originAirportLat, Double originAirportLon,
                     String destinationAirport, String destinationAirportName, Double destinationAirportLat, Double destinationAirportLon) {
}
