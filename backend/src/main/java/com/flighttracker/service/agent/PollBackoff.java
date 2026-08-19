package com.flighttracker.service.agent;

import java.time.Duration;
import java.time.Instant;

/**
 * Shared "are we cooling down, and for how long" state machine for a
 * FlightDataAgent's poll(). Every agent hits the same failure modes against
 * its upstream — rate limiting, timeouts, outright outages — so this lives
 * here once instead of being copy-pasted into each new agent implementation.
 *
 * Not thread-safe by design: AgentOrchestrator's @Scheduled poll loop runs
 * on a single thread by default, and a given agent's poll() is only ever
 * invoked from that one thread, never concurrently with itself.
 */
public class PollBackoff {

    private Instant until = Instant.EPOCH;
    private int consecutiveFailures = 0;

    public boolean isCoolingDown(Instant now) {
        return now.isBefore(until);
    }

    public Instant coolingDownUntil() {
        return until;
    }

    public void recordSuccess() {
        consecutiveFailures = 0;
    }

    /**
     * Records a failure and returns exponential backoff — minBackoff, 2x,
     * 4x, 8x, ... capped at maxBackoff. Pass a harsher (minBackoff,
     * maxBackoff) pair for failures that mean the upstream itself is
     * unhealthy (e.g. a 5xx) versus a merely transient one (e.g. a timeout),
     * so the two don't escalate at the same rate.
     */
    public Duration recordFailure(Duration minBackoff, Duration maxBackoff) {
        consecutiveFailures++;
        Duration wait = minBackoff.multipliedBy(1L << Math.min(consecutiveFailures - 1, 4));
        Duration capped = wait.compareTo(maxBackoff) > 0 ? maxBackoff : wait;
        until = Instant.now().plus(capped);
        return capped;
    }

    /** Records a failure but cools down for an explicit duration (e.g. a Retry-After header) rather than the computed backoff. */
    public void recordFailure(Duration explicitWait) {
        consecutiveFailures++;
        until = Instant.now().plus(explicitWait);
    }
}
