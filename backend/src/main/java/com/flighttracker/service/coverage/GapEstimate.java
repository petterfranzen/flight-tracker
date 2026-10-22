package com.flighttracker.service.coverage;

import java.time.Instant;

/**
 * The estimator's answer for one instant.
 *
 * @param state               COVERAGE_LOST or LANDED_INFERRED
 * @param landingProbability  0..1, the probability that it has landed by {@code at}
 * @param confidence          confidence in {@code state}: the landing
 *                            probability for LANDED_INFERRED, one minus it
 *                            for COVERAGE_LOST
 * @param estLat              estimated position
 * @param estLon              estimated position
 * @param radiusM             ~95% horizontal radius around the estimate
 * @param at                  the instant estimated for (the input's now)
 * @param landingAirportIcao  candidate airport, or null
 * @param landingRunway       candidate runway ident, or null
 * @param touchdownAt         predicted touchdown, or null without a candidate
 * @param geometry            the approach features behind the estimate
 * @param model               estimator id and version, such as "physics-v1"
 */
public record GapEstimate(TrackState state,
                          double landingProbability,
                          double confidence,
                          double estLat,
                          double estLon,
                          double radiusM,
                          Instant at,
                          String landingAirportIcao,
                          String landingRunway,
                          Instant touchdownAt,
                          ApproachGeometry geometry,
                          String model) {
}
