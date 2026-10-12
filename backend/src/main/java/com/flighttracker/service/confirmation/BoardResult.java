package com.flighttracker.service.confirmation;

import java.time.Duration;
import java.util.List;

/**
 * A board provider's answer. {@code entries} is the complete board for FOUND
 * (possibly empty), {@code retryAfter} is set only (and optionally) for
 * THROTTLED or FAILED. {@code costUnits} is what the call consumed upstream
 * (calls, pages or billing units), charged against the provider's daily and
 * monthly budgets; it defaults to 1, and 0 is allowed for a call that cost
 * nothing, such as a 429.
 */
public record BoardResult(LookupResult.Status status, List<BoardEntry> entries, Duration retryAfter, int costUnits) {

    public BoardResult {
        entries = entries == null ? List.of() : List.copyOf(entries);
        costUnits = Math.max(0, costUnits);
    }

    public static BoardResult found(List<BoardEntry> entries) {
        return new BoardResult(LookupResult.Status.FOUND, entries, null, 1);
    }

    /** The upstream has no board for this airport and date (yet). */
    public static BoardResult notFound() {
        return new BoardResult(LookupResult.Status.NOT_FOUND, List.of(), null, 1);
    }

    public static BoardResult throttled(Duration retryAfter) {
        return new BoardResult(LookupResult.Status.THROTTLED, List.of(), retryAfter, 1);
    }

    public static BoardResult failed() {
        return new BoardResult(LookupResult.Status.FAILED, List.of(), null, 1);
    }

    public BoardResult withCost(int units) {
        return new BoardResult(status, entries, retryAfter, units);
    }
}
