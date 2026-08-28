package com.flighttracker.service.enrichment;

/**
 * Origin/destination for an aircraft's most recent flight leg. The ICAO
 * codes are always attempted; the full names are only available from
 * adsbdb's callsign lookup — the OpenSky fallback (bare estimated-airport
 * codes, no name data) leaves the *Name fields null.
 */
public record Route(String originAirport, String originAirportName,
                     String destinationAirport, String destinationAirportName) {
}
