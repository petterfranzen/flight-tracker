package com.flighttracker.dto;

import com.flighttracker.service.coverage.GapEstimate;
import com.flighttracker.service.confirmation.Confirmation;
import com.flighttracker.service.coverage.TrackState;
import com.flighttracker.service.live.LiveAircraft;

import java.time.Instant;
import java.util.Optional;

/**
 * GET /api/flights/{icao24}/status: where one live aircraft stands in the
 * coverage-gap lifecycle (see docs/agents/PROGRESS.md for the contract).
 * {@code lastSeen*} is the last real report, never the display position.
 * {@code gate}, {@code terminal} and {@code confirmedAt} are filled only by a
 * provider's confirmation (LANDED_CONFIRMED, AT_GATE).
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

    /**
     * The status with a provider's confirmation taking precedence: it is never
     * downgraded by what the live aircraft or its estimate says. An actual
     * gate-in time means AT_GATE, otherwise an actual touchdown means
     * LANDED_CONFIRMED. The landing keeps the estimator's airport and runway
     * where known.
     */
    public static TrackStatus from(LiveAircraft a, Optional<Confirmation> confirmation) {
        if (confirmation.isEmpty()) return from(a);
        Confirmation c = confirmation.get();
        boolean atGate = c.gateAt() != null;
        GapEstimate gap = a.gap();
        String airport = gap != null && gap.landingAirportIcao() != null ? gap.landingAirportIcao()
                : c.info().arrivalAirportIcao();
        Landing landing = airport == null ? null
                : new Landing(airport, gap == null ? null : gap.landingRunway(),
                        c.info().actualOn() != null ? c.info().actualOn() : gap == null ? null : gap.touchdownAt());
        return new TrackStatus(a.icao24(), atGate ? TrackState.AT_GATE : TrackState.LANDED_CONFIRMED, 1.0,
                c.providerId(), "confirmed", a.observedAt(), a.latitude(), a.longitude(), null, landing,
                c.info().gate(), c.info().terminal(), atGate ? c.gateAt() : c.landedAt());
    }

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
