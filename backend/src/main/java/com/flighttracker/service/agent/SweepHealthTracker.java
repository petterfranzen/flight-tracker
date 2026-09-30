package com.flighttracker.service.agent;

import org.springframework.stereotype.Component;

import java.time.Instant;
import java.util.Optional;

/**
 * Tracks when the global sweep (AgentOrchestrator.runGlobalSweep) last
 * completed — backs GET /api/health/sweep (cloud migration A1, PLAN.md §6
 * item 11), a monitoring-only endpoint that reports unhealthy once the
 * sweep has gone quiet for 3× its own interval, independent of the poll
 * window or anything OpenSky-related the main /api/health check
 * deliberately avoids depending on.
 *
 * Records completion of the whole cycle, not success of every individual
 * agent within it — AgentOrchestrator already catches and logs a single
 * agent's failure without aborting the cycle (see its own javadoc), and
 * this tracker's job is "is the scheduler still running sweeps at all",
 * not "did every configured source answer this time".
 */
@Component
public class SweepHealthTracker {

    private volatile Instant lastSweepAt;

    public void recordSweepCompleted() {
        lastSweepAt = Instant.now();
    }

    public Optional<Instant> lastSweepAt() {
        return Optional.ofNullable(lastSweepAt);
    }
}
