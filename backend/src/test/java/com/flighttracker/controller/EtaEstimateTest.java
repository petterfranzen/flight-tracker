package com.flighttracker.controller;

import com.flighttracker.model.Aircraft;
import com.flighttracker.model.FlightPosition;
import org.junit.jupiter.api.Test;

import java.time.Instant;

import static org.assertj.core.api.Assertions.assertThat;

/** The dossier's ETA: distance to the destination over groundspeed. */
class EtaEstimateTest {

    private static final Instant SEEN = Instant.parse("2026-10-12T11:00:00Z");

    private static FlightPosition at(double lat, double lon, Double velocityMs, boolean onGround) {
        return new FlightPosition(null, "4ca123", "SAS123", SEEN, lat, lon, 3000.0, velocityMs, 0.0, 0.0,
                onGround, "test");
    }

    private static Aircraft headingFor(Double lat, Double lon) {
        return new Aircraft("4ca123", null, null, null, null, null, "ESSA", null, null, null, lat, lon,
                null, null, null, null, null);
    }

    @Test
    void oneDegreeOfLatitudeAt200ms_isAbout9Minutes() {
        // 1° of latitude ≈ 111.19 km; at 200 m/s that is ≈ 9.27 min.
        assertThat(EtaEstimate.minutes(at(58.0, 18.0, 200.0, false), headingFor(59.0, 18.0))).isEqualTo(9L);
    }

    @Test
    void noEta_withoutPositionDestinationOrMeaningfulSpeed() {
        Aircraft dest = headingFor(59.0, 18.0);
        assertThat(EtaEstimate.minutes(null, dest)).isNull();
        assertThat(EtaEstimate.minutes(at(58.0, 18.0, 200.0, false), headingFor(null, 18.0))).isNull();
        assertThat(EtaEstimate.minutes(at(58.0, 18.0, 200.0, false), headingFor(59.0, null))).isNull();
        assertThat(EtaEstimate.minutes(at(58.0, 18.0, 200.0, true), dest)).isNull();
        assertThat(EtaEstimate.minutes(at(58.0, 18.0, null, false), dest)).isNull();
        assertThat(EtaEstimate.minutes(at(58.0, 18.0, 19.9, false), dest)).isNull();
    }
}
