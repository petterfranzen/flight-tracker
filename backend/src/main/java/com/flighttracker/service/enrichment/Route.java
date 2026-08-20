package com.flighttracker.service.enrichment;

/** Origin/destination ICAO airport codes for an aircraft's most recent flight leg, from OpenSky. */
public record Route(String originAirport, String destinationAirport) {
}
