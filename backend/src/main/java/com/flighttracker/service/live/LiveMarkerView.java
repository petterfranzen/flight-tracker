package com.flighttracker.service.live;

import com.flighttracker.dto.LiveMarker;

import java.time.Instant;

/**
 * Concrete LiveMarker — the interface used to be a Spring Data native-query
 * projection, auto-implemented by a JDK proxy straight from
 * aircraft_latest_position's result-set columns. LiveStateStore has no
 * result set to project from any more, so this is the plain equivalent:
 * same getters, so it serializes identically over JSON (Jackson introspects
 * the runtime class's getters, not the declared List<LiveMarker> element
 * type — see FlightController.live).
 */
final class LiveMarkerView implements LiveMarker {

    private final String icao24;
    private final String callsign;
    private final Instant observedAt;
    private final double latitude;
    private final double longitude;
    private final Double headingDeg;
    private final boolean onGround;

    LiveMarkerView(String icao24, String callsign, Instant observedAt,
                   double latitude, double longitude, Double headingDeg, boolean onGround) {
        this.icao24 = icao24;
        this.callsign = callsign;
        this.observedAt = observedAt;
        this.latitude = latitude;
        this.longitude = longitude;
        this.headingDeg = headingDeg;
        this.onGround = onGround;
    }

    @Override
    public String getIcao24() { return icao24; }

    @Override
    public String getCallsign() { return callsign; }

    @Override
    public Instant getObservedAt() { return observedAt; }

    @Override
    public double getLatitude() { return latitude; }

    @Override
    public double getLongitude() { return longitude; }

    @Override
    public Double getHeadingDeg() { return headingDeg; }

    @Override
    public boolean isOnGround() { return onGround; }
}
