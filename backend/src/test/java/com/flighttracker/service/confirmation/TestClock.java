package com.flighttracker.service.confirmation;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;

/**
 * A clock the test moves by hand. It starts at the real now, rounded to a UTC
 * noon, because PollBackoff stamps its cool-down with the system clock.
 */
final class TestClock extends Clock {
    private Instant now;

    TestClock() {
        this.now = Instant.now();
    }

    @Override public ZoneId getZone() { return ZoneOffset.UTC; }
    @Override public Clock withZone(ZoneId zone) { return this; }
    @Override public Instant instant() { return now; }

    void advance(Duration d) {
        now = now.plus(d);
    }

    void set(Instant t) {
        now = t;
    }
}
