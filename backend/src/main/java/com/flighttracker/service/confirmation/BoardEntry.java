package com.flighttracker.service.confirmation;

import java.util.Locale;

/**
 * One flight on an arrivals board.
 *
 * @param callsign     ICAO callsign as ADS-B broadcasts it, for example {@code SAS1234}
 * @param flightNumber IATA flight number, for example {@code SK1234}; nullable. Parsed but not used by
 *                     the service yet: reserved for IATA flight-number matching (AeroDataBox is next)
 * @param registration tail number, for example {@code SE-RUA}; nullable
 * @param info         what the board knows about the arrival (actual on/in, gate, terminal, airport)
 */
public record BoardEntry(String callsign, String flightNumber, String registration, ArrivalInfo info) {

    /** Trimmed and upper case; the key a board entry and a live aircraft are matched on. Null becomes "". */
    public static String normalizeCallsign(String callsign) {
        return callsign == null ? "" : callsign.trim().toUpperCase(Locale.ROOT);
    }

    /** Upper case without spaces and dashes, so {@code se-rua} equals {@code SERUA}; null becomes "". */
    public static String normalizeRegistration(String registration) {
        return registration == null ? "" : registration.replaceAll("[\\s-]", "").toUpperCase(Locale.ROOT);
    }
}
