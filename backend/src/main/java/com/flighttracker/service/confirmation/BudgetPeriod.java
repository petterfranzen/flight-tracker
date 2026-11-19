package com.flighttracker.service.confirmation;

import java.util.function.Function;

/**
 * One budget period of a provider (a UTC day or a UTC month): its limit, the
 * units spent in it, and whether its stored count was unreadable (then it is
 * treated as spent until it rolls over). Used by {@link ConfirmationBudgets}.
 */
final class BudgetPeriod<P> {

    private final String name;
    private final String resetsAt;
    final Integer limit;
    P period;
    int units;
    boolean blocked;
    private P exhaustedLoggedFor;

    /**
     * @param name     "daily" or "monthly", as the log lines say it
     * @param resetsAt when the period rolls over, as the log lines say it
     * @param limit    the budget in units; null is unlimited
     */
    BudgetPeriod(String name, String resetsAt, Integer limit) {
        this.name = name;
        this.resetsAt = resetsAt;
        this.limit = limit;
    }

    /** True when the period cannot take {@code extra} more units. */
    boolean refuses(int extra) {
        return blocked || exceedsLimit(extra);
    }

    private boolean exceedsLimit(int extra) {
        return limit != null && units + extra > limit;
    }

    /** True the first time it is called within the current period (to log a refusal once). */
    boolean firstRefusalThisPeriod() {
        if (period.equals(exhaustedLoggedFor)) return false;
        exhaustedLoggedFor = period;
        return true;
    }

    /** Why the period refuses calls, for the out-of-budget log line. */
    String refusalReason() {
        return blocked
                ? "its stored " + name + " count is unreadable, so it is treated as spent until " + resetsAt
                : "its " + name + " budget of " + limit + " units is spent, no more calls until " + resetsAt;
    }

    void add(int delta) {
        units = Math.max(0, units + delta);
    }

    /** Starts {@code now} with nothing spent, unless it is already the current period. True if it rolled over. */
    boolean rollTo(P now) {
        if (now.equals(period)) return false;
        start(now, false);
        return true;
    }

    /** Starts {@code now} as spent: its stored count could not be read. */
    void block(P now) {
        start(now, true);
    }

    private void start(P now, boolean spent) {
        period = now;
        units = 0;
        blocked = spent;
    }

    /** Reads a stored {@code <period>:<units>}; false (and nothing changed) when it is corrupt or negative. */
    boolean read(String stored, Function<String, P> parser) {
        try {
            String[] fields = stored.split(":", -1);
            if (fields.length != 2) return false;
            P parsed = parser.apply(fields[0]);
            int storedUnits = Integer.parseInt(fields[1]);
            if (storedUnits < 0) return false;
            period = parsed;
            units = storedUnits;
            return true;
        } catch (RuntimeException e) {
            return false;
        }
    }

    /** The {@code <period>:<units>} form {@link #read} takes back. */
    String stored() {
        return period + ":" + units;
    }
}
