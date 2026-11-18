package com.flighttracker.service.confirmation;

import com.flighttracker.service.coverage.GapEstimate;
import com.flighttracker.service.coverage.Runway;
import com.flighttracker.service.coverage.RunwayIndex;
import com.flighttracker.service.coverage.TrackState;
import com.flighttracker.service.enrichment.CallsignRouteService;
import com.flighttracker.service.enrichment.Route;
import com.flighttracker.service.live.LiveAircraft;

import java.time.Duration;
import java.time.Instant;

/** Which live aircraft are arrival candidates, at which airport; the rules are in {@link ArrivalConfirmationService}. */
final class ArrivalCandidateRules {

    /** An on-ground report this close to a runway threshold counts as being at its airport. */
    static final double RUNWAY_AIRPORT_RADIUS_M = ArrivalConfirmationService.RUNWAY_AIRPORT_RADIUS_M;

    private final CallsignRouteService routeService;
    private final RunwayIndex runwayIndex;
    private final double minLandingProbability;
    private final Duration onGroundWindow;

    ArrivalCandidateRules(CallsignRouteService routeService, RunwayIndex runwayIndex,
                          double minLandingProbability, Duration onGroundWindow) {
        this.routeService = routeService;
        this.runwayIndex = runwayIndex;
        this.minLandingProbability = minLandingProbability;
        this.onGroundWindow = onGroundWindow;
    }

    /** The candidate for one aircraft, or null when it is not one. */
    ArrivalCandidate candidate(LiveAircraft a, Instant now, Confirmation confirmed) {
        return a.onGround() ? onGround(a, now, confirmed) : afterGap(a, now, confirmed);
    }

    private ArrivalCandidate onGround(LiveAircraft a, Instant now, Confirmation confirmed) {
        Instant since = a.landedSince();
        if (since == null || since.isBefore(now.minus(onGroundWindow))) return null;
        // Where it is beats where it was going: a diversion lands elsewhere.
        String airport = runwayIndex.near(a.latitude(), a.longitude(), RUNWAY_AIRPORT_RADIUS_M).stream()
                .findFirst().map(Runway::airportIcao).orElseGet(() -> destination(a));
        return new ArrivalCandidate(a, 3, airport, since, confirmed);
    }

    private ArrivalCandidate afterGap(LiveAircraft a, Instant now, Confirmation confirmed) {
        GapEstimate gap = a.gap();
        if (gap == null || gap.touchdownAt() == null) return null;
        int priority = gapPriority(gap, now);
        return priority == 0 ? null : new ArrivalCandidate(a, priority, airportOf(a, gap), gap.touchdownAt(), confirmed);
    }

    /** 1 for an inferred landing, 2 for a likely landing whose touchdown has passed, else 0 (not a candidate). */
    private int gapPriority(GapEstimate gap, Instant now) {
        if (gap.state() == TrackState.LANDED_INFERRED) return 1;
        if (gap.state() != TrackState.COVERAGE_LOST || gap.touchdownAt().isAfter(now)) return 0;
        return gap.landingProbability() >= minLandingProbability ? 2 : 0;
    }

    private String airportOf(LiveAircraft a, GapEstimate gap) {
        return gap.landingAirportIcao() != null ? gap.landingAirportIcao() : destination(a);
    }

    private String destination(LiveAircraft a) {
        return routeService.cached(a.callsign()).map(Route::destinationAirport).orElse(null);
    }
}
