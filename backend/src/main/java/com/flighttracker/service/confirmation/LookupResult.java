package com.flighttracker.service.confirmation;

import java.time.Duration;

/**
 * A provider's answer. {@code info} is set only for FOUND, {@code retryAfter}
 * only (and optionally) for THROTTLED or FAILED, when the upstream said how
 * long to wait.
 */
public record LookupResult(Status status, ArrivalInfo info, Duration retryAfter) {

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
}
