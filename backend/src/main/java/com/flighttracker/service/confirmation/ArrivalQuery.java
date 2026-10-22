package com.flighttracker.service.confirmation;

import java.time.Instant;

/**
 * One question to a provider: did this flight arrive?
 *
 * @param icao24             the airframe
 * @param callsign           the flight's callsign, as broadcast
 * @param arrivalAirportIcao where we think it landed, or null when unknown
 * @param expectedArrivalAt  when it touched down (inferred touchdown, or the
 *                           start of the on-ground streak); a provider uses it
 *                           to pick the right leg of a callsign that flies daily
 */
public record ArrivalQuery(String icao24,
                           String callsign,
                           String arrivalAirportIcao,
                           Instant expectedArrivalAt) {
}
