package com.flighttracker.dto;

import com.flighttracker.service.coverage.GapEstimate;
import com.flighttracker.service.coverage.TrackState;
import com.flighttracker.service.live.LiveAircraft;

import java.time.Instant;

/**
 * GET /api/flights/{icao24}/status: where one live aircraft stands in the
 * coverage-gap lifecycle (see docs/agents/PROGRESS.md for the contract).
 * {@code lastSeen*} is the last real report, never the display position.
 * {@code gate}, {@code terminal} and {@code confirmedAt} are reserved for
 * confirmation providers and are always null for now.
 *
 * @param confidence confidence in {@code state} (0..1); null for LIVE
 * @param source     adsb, physics, model, or a provider id
 * @param sourceKind observed, inferred or confirmed
 * @param estimate   only for COVERAGE_LOST and LANDED_INFERRED
 * @param landing    only when the estimator found a landing airport
 */
public record TrackStatus(String icao24,
                          TrackState state,
                          Double confidence,
                          String source,
                          String sourceKind,
                          Instant lastSeenAt,
                          double lastSeenLat,
                          double lastSeenLon,
                          Estimate estimate,
                          Landing landing,
                          String gate,
                          String terminal,
                          Instant confirmedAt) {

    /** The estimated position; {@code radiusM} is the ~95% horizontal radius, {@code at} when it was computed. */
    public record Estimate(double lat, double lon, double radiusM, Instant at, double landingProbability) { }

    /** The candidate landing; {@code runway} may be null, {@code touchdownAt} is predicted or inferred. */
    public record Landing(String airportIcao, String runway, Instant touchdownAt) { }

    public static TrackStatus from(LiveAircraft a) {
        Instant seenAt = a.observedAt();
        if (a.onGround()) {
            return new TrackStatus(a.icao24(), TrackState.ON_GROUND, 1.0, "adsb", "observed",
                    seenAt, a.latitude(), a.longitude(), null, null, null, null, null);
        }
        GapEstimate gap = a.gap();
        if (gap == null) {
            return new TrackStatus(a.icao24(), TrackState.LIVE, null, "adsb", "observed",
                    seenAt, a.latitude(), a.longitude(), null, null, null, null, null);
        }
        Landing landing = gap.landingAirportIcao() == null ? null
                : new Landing(gap.landingAirportIcao(), gap.landingRunway(), gap.touchdownAt());
        return new TrackStatus(a.icao24(), gap.state(), gap.confidence(), gap.probabilitySource(), "inferred",
                seenAt, a.latitude(), a.longitude(),
                new Estimate(gap.estLat(), gap.estLon(), gap.radiusM(), gap.at(), gap.landingProbability()),
                landing, null, null, null);
    }
}
