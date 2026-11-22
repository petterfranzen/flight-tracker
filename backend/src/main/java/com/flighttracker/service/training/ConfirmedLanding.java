package com.flighttracker.service.training;

import java.time.Instant;

/**
 * A confirmation provider's landing for one coverage gap: the aircraft
 * {@code icao24}, whose gap began with the report at {@code lastObservedAt},
 * landed at {@code onTime} at {@code airportIcao} according to {@code providerId}.
 */
public record ConfirmedLanding(String icao24, Instant lastObservedAt, String providerId,
                               Instant onTime, String airportIcao) {
}
