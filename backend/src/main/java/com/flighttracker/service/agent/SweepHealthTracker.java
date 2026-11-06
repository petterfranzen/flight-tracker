package com.flighttracker.service.agent;

import org.springframework.stereotype.Component;

import java.time.Instant;
import java.util.Optional;

/**
 * Tracks when the global sweep (AgentOrchestrator.runGlobalSweep) last
 * actually produced data — backs GET /api/health and GET /api/health/sweep
 * (cloud migration A1, PLAN.md §6 item 11), plus the ops-stats freshness
 * block. /api/health/sweep reports unhealthy once the sweep has gone quiet
 * for 3× its own interval, independent of the poll window or anything
 * OpenSky-related the main /api/health check deliberately avoids depending
 * on.
 *
 * <p><b>{@code lastSweepAt} only advances on a sweep that wrote rows.</b>
 * It used to advance on every completed cycle, so a sweep that skipped the
 * network call (OpenSky backoff, credits spent) or came back empty still
 * looked fresh — the tracker claimed freshness the data did not have. Now a
 * productive sweep stamps the time and resets the skip run; an unproductive
 * one bumps {@link #consecutiveSkips()} and leaves the stamp exactly where
 * the last real data left it.
 *
 * <p>Recorded for the whole cycle, not per-agent: AgentOrchestrator already
 * catches and logs a single agent's failure without aborting the cycle (see
 * its own javadoc), and this tracker's job is "is fresh data still arriving
 * at all", not "did every configured source answer this time". One source
 * writing rows is enough to keep the world's picture fresh.
 */
@Component
public class SweepHealthTracker {

    private volatile Instant lastSweepAt;
    private volatile int lastSweepRows;
    private volatile int consecutiveSkips;

    /** Records one completed global sweep and how many position rows it actually wrote. */
    public void recordSweepCompleted(int rowsWritten) {
        if (rowsWritten > 0) {
            lastSweepAt = Instant.now();
            lastSweepRows = rowsWritten;
            consecutiveSkips = 0;
        } else {
            consecutiveSkips++;
        }
    }

    /** Time of the last sweep that wrote rows; empty until the first productive one. */
    public Optional<Instant> lastSweepAt() {
        return Optional.ofNullable(lastSweepAt);
    }

    /** Rows written by the last productive sweep; 0 until one has happened. */
    public int lastSweepRows() {
        return lastSweepRows;
    }

    /** Consecutive completed sweeps that wrote nothing, reset to 0 by a productive one. */
    public int consecutiveSkips() {
        return consecutiveSkips;
    }
}
