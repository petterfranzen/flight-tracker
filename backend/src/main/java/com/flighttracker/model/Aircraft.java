package com.flighttracker.model;

import java.time.Instant;

/**
 * Cloud migration A2: plain Java record, row-mapped by
 * repository.AircraftRepository (JdbcClient), replacing the JPA @Entity
 * this used to be. Immutable — AircraftEnrichmentService no longer loads,
 * mutates and saves one of these; it calls dedicated
 * AircraftRepository.updateEnrichment/updateLandingCheck methods that
 * issue a targeted UPDATE directly, which is both simpler (no
 * load-mutate-save round trip) and a more natural fit for an immutable
 * record than reintroducing mutability would be.
 *
 * See AircraftEnrichmentService.checkLandingIfNeeded and
 * OpenSkyFlightsClient.confirmLanded for landingCheckObservedAt/
 * landingConfirmedAt's own meaning: landingCheckObservedAt is which
 * position report this aircraft was last checked against (throttles
 * re-checking and self-invalidates once a new leg's reports arrive);
 * landingConfirmedAt is OpenSky's own reported arrival time, null unless
 * confirmed.
 */
public record Aircraft(
        String icao24,
        String registration,
        String model,
        String operator,
        String originAirport,
        String originAirportName,
        String destinationAirport,
        String destinationAirportName,
        Double originAirportLat,
        Double originAirportLon,
        Double destinationAirportLat,
        Double destinationAirportLon,
        Instant metadataFetchedAt,
        Instant landingCheckObservedAt,
        Instant landingConfirmedAt,
        Instant firstSeenAt,
        Instant lastSeenAt
) {
}
