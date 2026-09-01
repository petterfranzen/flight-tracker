package com.flighttracker.service;

import org.junit.jupiter.api.Test;

import static com.flighttracker.service.FlightPhaseClassifier.FlightPhase.*;
import static com.flighttracker.service.FlightPhaseClassifier.classify;
import static org.assertj.core.api.Assertions.assertThat;

class FlightPhaseClassifierTest {

    @Test
    void onGroundFlag_isAuthoritative() {
        assertThat(classify(true, 4000.0, 100.0)).isEqualTo(ON_GROUND);
    }

    @Test
    void nullAltitude_readsAsLanded_notLevel() {
        assertThat(classify(false, null, 2000.0)).isEqualTo(ON_GROUND);
    }

    @Test
    void zeroAltitude_readsAsLanded() {
        assertThat(classify(false, 0.0, 500.0)).isEqualTo(ON_GROUND);
    }

    @Test
    void negativeAltitude_readsAsLanded() {
        assertThat(classify(false, -10.0, 500.0)).isEqualTo(ON_GROUND);
    }

    @Test
    void nullAltitude_withNoEarlierReference_stillReadsAsLanded() {
        assertThat(classify(false, null, null)).isEqualTo(ON_GROUND);
    }

    @Test
    void positiveAltitude_withNoEarlierReference_readsAsLevel() {
        assertThat(classify(false, 3000.0, null)).isEqualTo(LEVEL);
    }

    @Test
    void smallAltitudeChange_readsAsLevel() {
        assertThat(classify(false, 3050.0, 3000.0)).isEqualTo(LEVEL);
    }

    @Test
    void climbingAboveLowThreshold_readsAsClimbing() {
        assertThat(classify(false, 3000.0, 2000.0)).isEqualTo(CLIMBING);
    }

    @Test
    void climbingBelowLowThreshold_readsAsTakingOff() {
        assertThat(classify(false, 1000.0, 200.0)).isEqualTo(TAKING_OFF);
    }

    @Test
    void descendingAboveLowThreshold_readsAsDescending() {
        assertThat(classify(false, 3000.0, 4000.0)).isEqualTo(DESCENDING);
    }

    @Test
    void descendingBelowLowThreshold_readsAsLanding() {
        assertThat(classify(false, 1000.0, 1800.0)).isEqualTo(LANDING);
    }
}
