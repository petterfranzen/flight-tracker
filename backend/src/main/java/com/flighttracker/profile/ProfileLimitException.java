package com.flighttracker.profile;

/**
 * Thrown when profile input breaks a cap in {@link ProfileLimits} or is
 * malformed (bad JSON, bad date, unknown kind). Nothing is truncated or
 * written. The step-3 login API maps {@link Reason#TOO_MANY_ROWS} to 409 or
 * 422 and every other reason to 400 or 413; {@link #field()} names the input.
 */
public class ProfileLimitException extends RuntimeException {

    public enum Reason { TOO_LONG, TOO_MANY_ROWS, INVALID }

    private final Reason reason;
    private final String field;

    public ProfileLimitException(Reason reason, String field, String message) {
        super(message);
        this.reason = reason;
        this.field = field;
    }

    public Reason reason() {
        return reason;
    }

    public String field() {
        return field;
    }
}
