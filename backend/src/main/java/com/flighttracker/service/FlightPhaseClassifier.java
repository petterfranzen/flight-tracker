package com.flighttracker.service;

/**
 * Classifies an aircraft's current phase of flight from its altitude
 * trend — not from vertical_rate_ms alone. A single instantaneous
 * vertical-rate reading is noisy (jitters tick to tick even in level
 * flight), and doesn't distinguish "climbing out after takeoff" from
 * "climbing during a brief step-up at cruise" the way a real change in
 * altitude over an actual time window does. on_ground already tells us
 * definitively whether an aircraft is on the ground; this classifies
 * everything in between.
 */
public final class FlightPhaseClassifier {

    public enum FlightPhase {
        ON_GROUND, TAKING_OFF, CLIMBING, LEVEL, DESCENDING, LANDING
    }

    // Below this altitude, a climb/descent reads as the takeoff/landing
    // phase specifically rather than plain climbing/descending — roughly
    // the initial-climb/final-approach segment of a flight, comfortably
    // below any realistic cruise altitude (even a short regional hop
    // cruises well above this).
    private static final double LOW_ALTITUDE_THRESHOLD_M = 1500;

    // An altitude change smaller than this over the comparison window
    // reads as level flight rather than a genuine climb/descent — real
    // ADS-B reports drift by tens of meters tick to tick even when
    // genuinely level.
    private static final double LEVEL_TREND_THRESHOLD_M = 100;

    private FlightPhaseClassifier() {
    }

    /**
     * @param onGround         current on_ground state — authoritative; every other input is ignored when true.
     * @param currentAltitudeM current altitude, meters. Null (unknown reading) is treated as insufficient data.
     * @param earlierAltitudeM altitude at an earlier reference point (the caller decides how far back — e.g.
     *                         AircraftController uses ~3 minutes, or the start of the current leg if it's
     *                         younger than that), meters. Null when no earlier reference point exists yet
     *                         (e.g. a flight still in its first few minutes) — reported as LEVEL rather than
     *                         guessing, since there's nothing to compare against.
     */
    public static FlightPhase classify(boolean onGround, Double currentAltitudeM, Double earlierAltitudeM) {
        if (onGround) return FlightPhase.ON_GROUND;
        if (currentAltitudeM == null || earlierAltitudeM == null) return FlightPhase.LEVEL;

        double delta = currentAltitudeM - earlierAltitudeM;
        if (Math.abs(delta) < LEVEL_TREND_THRESHOLD_M) return FlightPhase.LEVEL;

        boolean low = currentAltitudeM < LOW_ALTITUDE_THRESHOLD_M;
        if (delta > 0) return low ? FlightPhase.TAKING_OFF : FlightPhase.CLIMBING;
        return low ? FlightPhase.LANDING : FlightPhase.DESCENDING;
    }
}
