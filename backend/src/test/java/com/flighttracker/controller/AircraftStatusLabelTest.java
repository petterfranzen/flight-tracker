package com.flighttracker.controller;

import com.flighttracker.dto.TrackStatus;
import com.flighttracker.service.coverage.TrackState;
import org.junit.jupiter.api.Test;

import java.time.Instant;

import static org.assertj.core.api.Assertions.assertThat;

/** The dossier's status line, per the label table in docs/agents/PROGRESS.md. */
class AircraftStatusLabelTest {

    private static final Instant SEEN = Instant.parse("2026-10-12T11:00:00Z");
    private static final Instant AT = Instant.parse("2026-10-12T11:02:00Z");

    private static TrackStatus status(TrackState state, Double confidence, double radiusM, TrackStatus.Landing landing) {
        TrackStatus.Estimate est = new TrackStatus.Estimate(59.65, 17.93, radiusM, AT, 0.4);
        return new TrackStatus("4ca123", state, confidence, "physics", "inferred", SEEN, 59.6, 17.9, est, landing,
                null, null, null);
    }

    private static final TrackStatus.Landing ESSA_19R =
            new TrackStatus.Landing("ESSA", "19R", Instant.parse("2026-10-12T11:03:10Z"));

    @Test
    void live_hasNoStatusLine() {
        TrackStatus live = new TrackStatus("4ca123", TrackState.LIVE, null, "adsb", "observed", SEEN, 59.6, 17.9,
                null, null, null, null, null);

        assertThat(AircraftController.statusLabel(live)).isNull();
    }

    @Test
    void coverageLost_showsTheRadius_andTheLandingWhenThereIsOne() {
        assertThat(AircraftController.statusLabel(status(TrackState.COVERAGE_LOST, 0.85, 1800, null)))
                .isEqualTo("Coverage lost · est. ±1.8 km");
        assertThat(AircraftController.statusLabel(status(TrackState.COVERAGE_LOST, 0.85, 1800, ESSA_19R)))
                .isEqualTo("Coverage lost · est. ±1.8 km · landing ~11:03 ESSA 19R");
        assertThat(AircraftController.statusLabel(status(TrackState.COVERAGE_LOST, 0.85, 640,
                new TrackStatus.Landing("ESSA", null, null))))
                .isEqualTo("Coverage lost · est. ±640 m · landing ESSA");
        assertThat(AircraftController.statusLabel(status(TrackState.COVERAGE_LOST, 0.1, 43_000, null)))
                .isEqualTo("Coverage lost · est. ±43 km");
    }

    @Test
    void landedInferred_showsThePercentageAndTheRunway() {
        assertThat(AircraftController.statusLabel(status(TrackState.LANDED_INFERRED, 0.92, 500, ESSA_19R)))
                .isEqualTo("Landed 92% (inferred) · ESSA 19R");
        assertThat(AircraftController.statusLabel(status(TrackState.LANDED_INFERRED, 0.92, 500, null)))
                .isEqualTo("Landed 92% (inferred)");
    }

    @Test
    void observedAndConfirmedStates() {
        assertThat(AircraftController.statusLabel(new TrackStatus("4ca123", TrackState.ON_GROUND, 1.0, "adsb", "observed",
                SEEN, 59.6, 17.9, null, null, null, null, null))).isEqualTo("On ground (ADS-B)");
        assertThat(AircraftController.statusLabel(new TrackStatus("4ca123", TrackState.LANDED_CONFIRMED, 1.0, "opensky",
                "confirmed", SEEN, 59.6, 17.9, null, null, null, null, SEEN))).isEqualTo("Landed (confirmed · opensky)");
        assertThat(AircraftController.statusLabel(new TrackStatus("4ca123", TrackState.AT_GATE, 1.0, "opensky",
                "confirmed", SEEN, 59.6, 17.9, null, null, "B14", null, SEEN))).isEqualTo("At gate B14 (confirmed)");
    }

    @Test
    void atGate_withoutAGate_readsAtGateConfirmed() {
        assertThat(AircraftController.statusLabel(new TrackStatus("4ca123", TrackState.AT_GATE, 1.0, "mock",
                "confirmed", SEEN, 59.6, 17.9, null, null, null, null, SEEN))).isEqualTo("At gate (confirmed)");
    }
}
