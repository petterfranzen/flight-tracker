package com.flighttracker.service.confirmation;

import java.time.Instant;

/**
 * What a provider knows about one arrival: the OOOI times (out of the gate,
 * off the runway, on the runway, in at the gate) and where it parked. Every
 * field is nullable, providers fill what their feed has.
 */
public record ArrivalInfo(Instant actualOut,
                          Instant actualOff,
                          Instant actualOn,
                          Instant actualIn,
                          String gate,
                          String terminal,
                          String arrivalAirportIcao) {

    /** 0 = nothing to confirm, 1 = landed (actualOn), 2 = at the gate (actualIn). */
    public int rank() {
        return actualIn != null ? 2 : actualOn != null ? 1 : 0;
    }
}
