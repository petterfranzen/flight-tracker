package com.flighttracker.service.training;

import org.springframework.stereotype.Component;

import java.util.Optional;

/** The default: no model is trained yet, so the physics estimate stands. */
@Component
public class NoLandingModel implements LandingModel {

    @Override
    public Optional<Double> landingProbability(TrackEndFeatures features) {
        return Optional.empty();
    }
}
