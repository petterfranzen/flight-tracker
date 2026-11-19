package com.flighttracker.controller;

import com.flighttracker.dto.TrackStatus;
import com.flighttracker.model.FlightPosition;
import com.flighttracker.service.FlightPhaseClassifier.FlightPhase;
import com.flighttracker.service.coverage.TrackState;

import java.time.Duration;
import java.time.Instant;

/**
 * Whether the dossier's aircraft has landed, and so when its flight time
 * stops counting.
 *
 * <p>Flight time stops counting at the last real report once the aircraft
 * is known (on_ground) or presumed (silent this long while descending — see
 * LiveVisibilityWindows.PRESUMED_LANDED_SILENCE) to have landed, rather than
 * running up against `now` indefinitely for a flight that's actually long
 * over. Still airborne (or too recently silent to presume anything) keeps
 * counting up to `now` as before. The coverage-gap estimator's
 * LANDED_INFERRED call is the primary signal (and ends the flight at its
 * touchdown time); the silence rule applies to every other state,
 * COVERAGE_LOST included, so a low-probability descender does not count
 * flight minutes forever.
 *
 * @param providerConfirmed a provider confirmed the landing (LANDED_CONFIRMED or AT_GATE)
 * @param presumedLanded    known, inferred or presumed to have landed
 * @param flightEnd         when flight time stops counting
 */
record LandingAssessment(boolean providerConfirmed, boolean presumedLanded, Instant flightEnd) {

    /**
     * @param current the latest position, or null
     * @param status  the coverage-gap status, or null when not in the live store
     */
    static LandingAssessment assess(FlightPosition current, TrackStatus status, FlightPhase phase, Instant now) {
        TrackState state = status == null ? null : status.state();
        boolean providerConfirmed = state == TrackState.LANDED_CONFIRMED || state == TrackState.AT_GATE;
        boolean inferredLanded = providerConfirmed || state == TrackState.LANDED_INFERRED;
        if (current == null) return new LandingAssessment(providerConfirmed, false, now);
        if (!inferredLanded && !observedOrSilentLanding(current, state, phase, now)) {
            return new LandingAssessment(providerConfirmed, false, now);
        }
        Instant touchdownAt = inferredLanded ? touchdownAt(status) : null;
        return new LandingAssessment(providerConfirmed, true, endAt(touchdownAt, current, now));
    }

    /** Only worth asking OpenSky once our own heuristic presumes landed and no provider has confirmed it. */
    boolean worthCheckingLanding() {
        return presumedLanded && !providerConfirmed;
    }

    private static boolean observedOrSilentLanding(FlightPosition current, TrackState state, FlightPhase phase,
                                                   Instant now) {
        return phase == FlightPhase.ON_GROUND || silent(current, state, phase, now);
    }

    /** The inferred touchdown when it is already past, else the last real report. */
    private static Instant endAt(Instant touchdownAt, FlightPosition current, Instant now) {
        return touchdownAt != null && touchdownAt.isBefore(now) ? touchdownAt : current.observedAt();
    }

    private static boolean silent(FlightPosition current, TrackState state, FlightPhase phase, Instant now) {
        boolean descendingOrLanding = phase == FlightPhase.DESCENDING || phase == FlightPhase.LANDING;
        return state != null && AircraftController.silentWhileDescending(
                state, descendingOrLanding, Duration.between(current.observedAt(), now));
    }

    private static Instant touchdownAt(TrackStatus status) {
        return status.landing() == null ? null : status.landing().touchdownAt();
    }
}
