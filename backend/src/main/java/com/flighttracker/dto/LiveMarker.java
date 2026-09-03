package com.flighttracker.dto;

import java.time.Instant;

/**
 * The bare fields the map needs to draw and select a marker — position,
 * heading, identity, and the observedAt FlightMap.tsx's client-side merge
 * logic orders updates by. Everything else on FlightPosition (altitude,
 * velocity, vertical rate, agent_source, the row id) only matters once an
 * aircraft is actually selected, and that path already fetches the full
 * row directly by icao24 (see FlightController.liveOne) — carrying it in
 * the bulk /live response too would multiply every unselected aircraft's
 * payload for fields nothing reads. At the zoom levels where this matters
 * most (a continent or the whole world can mean tens of thousands of
 * rows), that's most of the wire and JSON-parse cost of the response —
 * see FlightPositionRepository.findLiveMarkers(InBounds).
 *
 * on_ground stays even though the frontend itself never reads it: it's a
 * single boolean (negligible size next to the string/numeric fields
 * dropped above), and it's what lets the blackbox suite verify /live's own
 * liveness-window filter (see flights-live.test.js) without a second,
 * heavier round trip.
 */
public interface LiveMarker {
    String getIcao24();
    String getCallsign();
    Instant getObservedAt();
    double getLatitude();
    double getLongitude();
    Double getHeadingDeg();
    boolean isOnGround();
}
