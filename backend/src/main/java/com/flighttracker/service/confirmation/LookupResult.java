package com.flighttracker.service.confirmation;

import java.time.Duration;

/**
 * A provider's answer. {@code info} is set only for FOUND, {@code retryAfter}
 * only (and optionally) for THROTTLED or FAILED, when the upstream said how
 * long to wait. {@code costUnits} is what the call really consumed upstream; null
 * (the default) means the provider's {@link ArrivalConfirmationProvider#callCost()}.
 * A provider whose request never reached the upstream (no HTTP response, a
 * refused connection) says {@link #withCost 0}, and the gateway refunds the
 * charge. A THROTTLED answer is refunded whatever it says.
 */
public record LookupResult(Status status, ArrivalInfo info, Duration retryAfter, Integer costUnits) {

    public LookupResult {
        if (costUnits != null) costUnits = Math.max(0, costUnits);
    }

    public LookupResult(Status status, ArrivalInfo info, Duration retryAfter) {
        this(status, info, retryAfter, null);
    }

    public enum Status { FOUND, NOT_FOUND, THROTTLED, FAILED }

    public static LookupResult found(ArrivalInfo info) {
        return new LookupResult(Status.FOUND, info, null);
    }

    public static LookupResult notFound() {
        return new LookupResult(Status.NOT_FOUND, null, null);
    }

    public static LookupResult throttled(Duration retryAfter) {
        return new LookupResult(Status.THROTTLED, null, retryAfter);
    }

    public static LookupResult failed() {
        return new LookupResult(Status.FAILED, null, null);
    }

    /** The same answer, with the units the call really consumed (0 when it never reached the upstream). */
    public LookupResult withCost(int units) {
        return new LookupResult(status, info, retryAfter, units);
    }
}
