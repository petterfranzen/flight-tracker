package com.flighttracker.service.training;

import java.util.Optional;

/**
 * A learned replacement for the physics landing probability. EstimatorAgent
 * asks it after every physics estimate. An empty answer keeps the physics
 * number. A present one replaces the landing probability, and the status
 * source becomes "model". Implement this as a {@code @Component} to take
 * over from {@link NoLandingModel}, and mark it {@code @Primary} so it is the
 * one the estimator gets.
 */
public interface LandingModel {

    /** The probability (0..1) that the aircraft has landed by now, or empty to keep the physics answer. */
    Optional<Double> landingProbability(TrackEndFeatures features);
}
