package com.flighttracker.dto;

import com.flighttracker.model.FlightPosition;

import java.time.Instant;

/**
 * One WebSocket push frame: just what the map needs to draw and move a
 * marker (same fields as LiveMarker, the bulk /live shape). Altitude,
 * speed, vertical rate, agent source and the row id only matter for the
 * selected aircraft, which has its own priority poll (/{icao24}/live)
 * returning the full FlightPosition, so they're not worth pushing for
 * every aircraft in view.
 */
public record LiveFrame(
        String icao24,
        String callsign,
        Instant observedAt,
        double latitude,
        double longitude,
        Double headingDeg,
        boolean onGround
) {
    public static LiveFrame of(FlightPosition p) {
        return new LiveFrame(p.icao24(), p.callsign(), p.observedAt(), p.latitude(), p.longitude(), p.headingDeg(), p.onGround());
    }
}
