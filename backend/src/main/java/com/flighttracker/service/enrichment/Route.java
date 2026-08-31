package com.flighttracker.service.enrichment;

/**
 * Origin/destination for an aircraft's most recent flight leg. The ICAO
 * codes are always attempted; adsbdb's callsign lookup returns full names
 * and coordinates alongside its codes, while the OpenSky fallback (bare
 * estimated-airport codes) leaves those fields null here — but
 * AircraftEnrichmentService.backfillNames() fills them back in from a
 * local static reference table before this is persisted, so a caller
 * reading the saved Aircraft entity shouldn't normally see the gap.
 * Coordinates are what makes ETA computable — see AircraftController.
 */
public record Route(String originAirport, String originAirportName, Double originAirportLat, Double originAirportLon,
                     String destinationAirport, String destinationAirportName, Double destinationAirportLat, Double destinationAirportLon) {
}
