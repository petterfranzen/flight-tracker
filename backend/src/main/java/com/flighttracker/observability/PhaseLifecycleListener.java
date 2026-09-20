package com.flighttracker.observability;

import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.ContextClosedEvent;
import org.springframework.context.event.EventListener;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;

/**
 * Ties the two ends of a container's life to phase markers, so the
 * dashboard can tell "still booting" from "up" without guessing from
 * Docker's health check alone.
 *
 * The agent and estimator roles overwrite READY with their own phases the
 * moment they start working; the api role stays READY, which is the honest
 * answer for a process whose whole job is to answer requests.
 */
@Component
public class PhaseLifecycleListener {

    private final PhaseLogger phases;

    public PhaseLifecycleListener(PhaseLogger phases) {
        this.phases = phases;
    }

    @EventListener(ApplicationReadyEvent.class)
    public void onReady() {
        phases.ready("application started");
    }

    /**
     * Highest precedence so this runs before the rest of the shutdown
     * sequence closes the logging system out from under it — a
     * shutting_down marker nobody can read is no use.
     */
    @Order(Ordered.HIGHEST_PRECEDENCE)
    @EventListener(ContextClosedEvent.class)
    public void onShutdown() {
        phases.shuttingDown("context closing");
    }
}
