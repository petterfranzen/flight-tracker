package com.flighttracker.service.confirmation;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;

/**
 * {@link SwedaviaArrivalsProvider}'s primary and secondary subscription keys:
 * which one to use next, and the lock-out once every configured key has been
 * rejected in a row.
 */
final class SwedaviaKeys {

    private final String primaryKey;
    private final String secondaryKey;
    private final Clock clock;

    /** The key to use next: switched on every 401/403, so a rotated-out key is not hammered. */
    private volatile boolean secondaryPreferred;
    /** Keys rejected one after the other; any answer that is not a 401/403 resets it. */
    private volatile int rejectedInARow;
    /** While the clock is before this, every key was rejected and the provider is off. */
    private volatile Instant lockedUntil = Instant.EPOCH;

    SwedaviaKeys(SwedaviaSettings settings, Clock clock) {
        this.primaryKey = settings.primaryKey();
        this.secondaryKey = settings.secondaryKey();
        this.clock = clock;
    }

    /** At least one key is configured. */
    boolean any() {
        return !primaryKey.isEmpty() || !secondaryKey.isEmpty();
    }

    /** Every key was just rejected, and the next UTC midnight has not come yet. */
    boolean lockedOut() {
        return clock.instant().isBefore(lockedUntil);
    }

    /** The key in use: the preferred one, or the only one configured. */
    String preferred() {
        String first = secondaryPreferred ? secondaryKey : primaryKey;
        String second = secondaryPreferred ? primaryKey : secondaryKey;
        return first.isEmpty() ? second : first;
    }

    /** An answer that was not a 401/403: the run of rejections is over. */
    void accepted() {
        rejectedInARow = 0;
    }

    /**
     * A 401/403: the next attempt uses the other key. When every key has now been rejected in a row,
     * locks until the next UTC midnight and returns that instant; null otherwise.
     */
    Instant rejected() {
        secondaryPreferred = !secondaryPreferred;
        if (++rejectedInARow < distinctKeys()) return null;
        rejectedInARow = 0;
        lockedUntil = clock.instant().atZone(ZoneOffset.UTC).toLocalDate().plusDays(1).atStartOfDay(ZoneOffset.UTC).toInstant();
        return lockedUntil;
    }

    private int distinctKeys() {
        if (primaryKey.isEmpty() || secondaryKey.isEmpty()) return 1;
        return primaryKey.equals(secondaryKey) ? 1 : 2;
    }
}
