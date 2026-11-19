package com.flighttracker.controller;

import com.flighttracker.dto.TrackStatus;
import com.flighttracker.model.FlightPosition;
import com.flighttracker.service.FlightPhaseClassifier.FlightPhase;
import com.flighttracker.service.coverage.TrackState;
import org.junit.jupiter.api.Test;

import java.time.Instant;

import static org.assertj.core.api.Assertions.assertThat;

/** When the dossier stops counting flight minutes, and whether it asks OpenSky to confirm a landing. */
class LandingAssessmentTest {

    private static final Instant NOW = Instant.parse("2026-10-12T12:00:00Z");
    private static final Instant SEEN_RECENTLY = NOW.minusSeconds(60);
    private static final Instant SEEN_LONG_AGO = NOW.minusSeconds(3600);

    private static FlightPosition position(Instant observedAt) {
        return new FlightPosition(null, "4ca123", "SAS123", observedAt, 59.6, 17.9, 900.0, 80.0, 190.0, -4.0,
                false, "test");
    }

    private static TrackStatus status(TrackState state, Instant touchdownAt) {
        TrackStatus.Landing landing = touchdownAt == null ? null : new TrackStatus.Landing("ESSA", "19R", touchdownAt);
        return new TrackStatus("4ca123", state, 0.9, "physics", "inferred", SEEN_RECENTLY, 59.6, 17.9, null, landing,
                null, null, null);
    }

    @Test
    void noPosition_keepsCountingToNow() {
        LandingAssessment l = LandingAssessment.assess(null, status(TrackState.LANDED_CONFIRMED, null), null, NOW);

        assertThat(l.presumedLanded()).isFalse();
        assertThat(l.providerConfirmed()).isTrue();
        assertThat(l.flightEnd()).isEqualTo(NOW);
        assertThat(l.worthCheckingLanding()).isFalse();
    }

    @Test
    void airborneAndRecent_keepsCountingToNow() {
        LandingAssessment l = LandingAssessment.assess(position(SEEN_RECENTLY), status(TrackState.LIVE, null),
                FlightPhase.DESCENDING, NOW);

        assertThat(l.presumedLanded()).isFalse();
        assertThat(l.flightEnd()).isEqualTo(NOW);
    }

    @Test
    void onGround_endsAtLastReport_andIsWorthChecking() {
        LandingAssessment l = LandingAssessment.assess(position(SEEN_RECENTLY), null, FlightPhase.ON_GROUND, NOW);

        assertThat(l.presumedLanded()).isTrue();
        assertThat(l.flightEnd()).isEqualTo(SEEN_RECENTLY);
        assertThat(l.worthCheckingLanding()).isTrue();
    }

    @Test
    void silentDescender_endsAtLastReport() {
        LandingAssessment l = LandingAssessment.assess(position(SEEN_LONG_AGO), status(TrackState.COVERAGE_LOST, null),
                FlightPhase.DESCENDING, NOW);

        assertThat(l.presumedLanded()).isTrue();
        assertThat(l.flightEnd()).isEqualTo(SEEN_LONG_AGO);
    }

    @Test
    void silentDescenderNotInLiveStore_keepsCounting() {
        LandingAssessment l = LandingAssessment.assess(position(SEEN_LONG_AGO), null, FlightPhase.DESCENDING, NOW);

        assertThat(l.presumedLanded()).isFalse();
        assertThat(l.flightEnd()).isEqualTo(NOW);
    }

    @Test
    void inferredLanding_endsAtPastTouchdown() {
        Instant touchdown = NOW.minusSeconds(120);
        LandingAssessment l = LandingAssessment.assess(position(SEEN_LONG_AGO),
                status(TrackState.LANDED_INFERRED, touchdown), FlightPhase.LEVEL, NOW);

        assertThat(l.presumedLanded()).isTrue();
        assertThat(l.flightEnd()).isEqualTo(touchdown);
        assertThat(l.worthCheckingLanding()).isTrue();
    }

    @Test
    void touchdownInTheFuture_endsAtLastReport() {
        LandingAssessment l = LandingAssessment.assess(position(SEEN_RECENTLY),
                status(TrackState.LANDED_INFERRED, NOW.plusSeconds(120)), FlightPhase.DESCENDING, NOW);

        assertThat(l.flightEnd()).isEqualTo(SEEN_RECENTLY);
    }

    @Test
    void providerConfirmed_isNotWorthChecking() {
        LandingAssessment l = LandingAssessment.assess(position(SEEN_RECENTLY), status(TrackState.AT_GATE, null),
                FlightPhase.ON_GROUND, NOW);

        assertThat(l.presumedLanded()).isTrue();
        assertThat(l.providerConfirmed()).isTrue();
        assertThat(l.worthCheckingLanding()).isFalse();
    }
}
