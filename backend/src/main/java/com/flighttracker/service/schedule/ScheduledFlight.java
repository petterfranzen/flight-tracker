package com.flighttracker.service.schedule;

import java.time.Instant;

/**
 * One row of a Swedavia board, as the flight search returns it. The times are those of the Swedavia
 * airport ({@code airport}): arrival times for an arrivals board, departure times for a departures board.
 * {@code icao24} is set when a live aircraft with this callsign is in the air near the flight's time;
 * {@code airborne} is then true.
 */
public record ScheduledFlight(String flightNumber, String callsign, String direction, String airport,
                              String departureIata, String arrivalIata,
                              Instant scheduled, Instant estimated, Instant actual,
                              String gate, String terminal, String statusCode, String status,
                              String icao24, boolean airborne) {

    /** The best time we have: actual, else estimated, else scheduled. */
    public Instant bestTime() {
        return actual != null ? actual : estimated != null ? estimated : scheduled;
    }

    public ScheduledFlight withLive(String liveIcao24) {
        return new ScheduledFlight(flightNumber, callsign, direction, airport, departureIata, arrivalIata,
                scheduled, estimated, actual, gate, terminal, statusCode, status, liveIcao24, liveIcao24 != null);
    }
}
