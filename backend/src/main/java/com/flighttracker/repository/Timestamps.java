package com.flighttracker.repository;

import java.time.Instant;

/**
 * Single Instant <-> epoch-millis-long helper (cloud migration A2 — PLAN.md
 * §6 item 4: "TIMESTAMPTZ mapping via a single Instant <-> long helper").
 * SQLite has no native timestamp type; every timestamp column in the
 * rewritten schema.sql is an INTEGER storing epoch milliseconds UTC, and
 * every repository in this package goes through these two methods rather
 * than each rolling its own conversion.
 */
public final class Timestamps {

    private Timestamps() {
    }

    public static Long toEpochMilli(Instant instant) {
        return instant == null ? null : instant.toEpochMilli();
    }

    public static Instant fromEpochMilli(Long epochMilli) {
        return epochMilli == null ? null : Instant.ofEpochMilli(epochMilli);
    }

    /** For a NOT NULL timestamp column, where the driver hands back a primitive long directly (ResultSet.getLong). */
    public static Instant fromEpochMilli(long epochMilli) {
        return Instant.ofEpochMilli(epochMilli);
    }
}
