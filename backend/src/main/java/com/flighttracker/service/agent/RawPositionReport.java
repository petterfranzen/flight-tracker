package com.flighttracker.service.agent;

import java.time.Instant;

/** Source-agnostic shape every FlightDataAgent normalises into. */
public record RawPositionReport(
        String icao24,
        String callsign,
        Instant observedAt,
        double latitude,
        double longitude,
        Double altitudeM,
        Double velocityMs,
        Double headingDeg,
        Double verticalRateMs,
        boolean onGround
) { }
