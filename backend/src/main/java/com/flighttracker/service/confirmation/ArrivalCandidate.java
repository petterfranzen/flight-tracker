package com.flighttracker.service.confirmation;

import com.flighttracker.service.live.LiveAircraft;

import java.time.Duration;
import java.time.Instant;

/**
 * One aircraft worth asking a provider about.
 *
 * @param priority   1 LANDED_INFERRED, 2 COVERAGE_LOST, 3 on the ground
 * @param airport    where it is thought to have landed, or null
 * @param expectedAt the expected (or actual) touchdown
 * @param known      the landing already confirmed for the aircraft (without a gate time), else null
 */
record ArrivalCandidate(LiveAircraft aircraft, int priority, String airport, Instant expectedAt, Confirmation known) {

    boolean confirmed() {
        return known != null;
    }

    /** True when the landing is already confirmed and {@code wait} has passed since its touchdown. */
    boolean gateWaitOver(Duration wait, Instant now) {
        if (known == null) return false;
        return !known.landedAt().plus(wait).isAfter(now);
    }

    ArrivalQuery query() {
        return new ArrivalQuery(aircraft.icao24(), aircraft.callsign(), airport, expectedAt);
    }
}
