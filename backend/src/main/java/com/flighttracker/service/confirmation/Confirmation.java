package com.flighttracker.service.confirmation;

import java.time.Instant;

/**
 * A provider's confirmation that an aircraft landed (and, when {@code info}
 * has an {@code actualIn}, reached the gate).
 *
 * @param providerId  the provider that said so, shown as the status source
 * @param info        what it reported; has an actualOn or an actualIn
 * @param confirmedAt when we got the answer
 * @param observedAt  the aircraft's last report when it was confirmed (the gap's key)
 */
public record Confirmation(String providerId, ArrivalInfo info, Instant confirmedAt, Instant observedAt) {

    /** When it landed: actualOn, or actualIn if the provider has no runway time. */
    public Instant landedAt() {
        return info.landedAt();
    }

    /** When it reached the gate, or null. */
    public Instant gateAt() {
        return info.actualIn();
    }
}
