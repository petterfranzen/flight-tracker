package com.flighttracker.service.coverage;

/**
 * Where an aircraft stands in the coverage-gap lifecycle. The estimator only
 * ever produces COVERAGE_LOST or LANDED_INFERRED; the others come from real
 * reports and, later, from confirmation providers.
 */
public enum TrackState {
    LIVE,
    COVERAGE_LOST,
    LANDED_INFERRED,
    ON_GROUND,
    LANDED_CONFIRMED,
    AT_GATE
}
