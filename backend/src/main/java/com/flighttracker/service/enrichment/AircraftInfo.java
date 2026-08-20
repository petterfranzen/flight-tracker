package com.flighttracker.service.enrichment;

/** Aircraft type/registration/operator, from adsbdb.com. Any field may be null. */
public record AircraftInfo(String model, String registration, String operator) {
}
