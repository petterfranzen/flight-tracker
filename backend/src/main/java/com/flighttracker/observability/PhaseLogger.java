package com.flighttracker.observability;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.Objects;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Prints a one-line marker saying what this container is currently doing,
 * for docker-monitor to read out of the log stream.
 *
 * Docker can say "running" and, given a HEALTHCHECK, "healthy". Neither
 * distinguishes a backend-agent halfway through a global sweep from one
 * sitting idle with nothing to do — and when someone has just started this
 * stack for a demo and is waiting on the map to fill in, that's the only
 * part they care about. The portfolio's dashboard surfaces these as
 * "Populating data", "Ready", and so on.
 *
 * The format is a convention shared with docker-monitor (which parses it)
 * and dinner-planner (which emits it): see docker-monitor's README under
 * "Phase reporting" for the vocabulary and the two rules. The one that
 * matters here is that markers are emitted on *transition only* — this
 * class enforces it rather than trusting call sites, because the obvious
 * place to call {@link #populating} is inside a loop that runs every few
 * seconds, and a marker per iteration would both bury the real logs and
 * trip docker-monitor's own traffic-spike detector.
 *
 * Not profile-scoped: all three roles (api, agent, estimator) run from the
 * same image and all three have something worth saying.
 *
 * Transition-only logging has a failure mode of its own: a container that
 * sits in one phase (typically idle or populating_data) for a long stretch
 * prints nothing at all in the meantime, which is indistinguishable from
 * "silently stuck" — exactly the ambiguity docker-monitor's own "no data"
 * log-content check exists to catch (default NO_DATA_IDLE_SECONDS: 600s).
 * {@link #heartbeat()} re-prints the current phase on a fixed schedule,
 * comfortably under that default, so quiet-because-healthy never gets
 * mistaken for quiet-because-stuck. It also refreshes {@link #HEARTBEAT_FILE},
 * which docker-compose's HEALTHCHECK for the headless agent/estimator
 * containers reads for freshness (see docker-compose.yml) — those two roles
 * have no port to probe the way backend-api's wget check does, so this file
 * is the only liveness signal available to them.
 */
@Component
public class PhaseLogger {

    private static final Logger log = LoggerFactory.getLogger(PhaseLogger.class);

    public static final String STARTING_UP = "starting_up";
    public static final String READY = "ready";
    public static final String POPULATING_DATA = "populating_data";
    public static final String IDLE = "idle";
    public static final String DEGRADED = "degraded";
    public static final String SHUTTING_DOWN = "shutting_down";

    private static final Path HEARTBEAT_FILE = Path.of("/tmp/phase-heartbeat");

    private final AtomicReference<String> current = new AtomicReference<>();
    private final AtomicReference<String> currentDetail = new AtomicReference<>();
    private volatile Instant lastPrintedAt = Instant.now();

    @Value("${flighttracker.observability.phase-heartbeat-seconds:240}")
    private long heartbeatSeconds;

    public PhaseLogger() {
        // Before Spring has finished wiring anything up — which is exactly
        // when someone watching a cold start wants to be told something is
        // happening.
        emit(STARTING_UP, "initialising");
    }

    public void starting(String detail) {
        emit(STARTING_UP, detail);
    }

    public void ready(String detail) {
        emit(READY, detail);
    }

    /** Doing real work: fetching, backfilling, writing. */
    public void populating(String detail) {
        emit(POPULATING_DATA, detail);
    }

    /** Up, but with nothing to do right now. */
    public void idle(String detail) {
        emit(IDLE, detail);
    }

    /** Running but impaired — upstream throttling us, a dependency down. */
    public void degraded(String detail) {
        emit(DEGRADED, detail);
    }

    public void shuttingDown(String detail) {
        emit(SHUTTING_DOWN, detail);
    }

    /**
     * Prints only when the phase actually changes. Note the detail is
     * deliberately NOT part of that comparison: a sweep that reports
     * "1/3" then "2/3" is still one continuous populating_data phase, and
     * re-printing per update is the log spam this exists to prevent.
     */
    private void emit(String phase, String detail) {
        String previous = current.getAndSet(phase);
        currentDetail.set(detail);
        touchHeartbeatFile();
        if (Objects.equals(previous, phase)) {
            return;
        }
        print(phase, detail);
    }

    /**
     * Re-prints the current phase, unchanged, once {@link #heartbeatSeconds}
     * has passed since anything last printed — see the class javadoc. A
     * plain fixed-rate {@code @Scheduled} rather than something driven by
     * call-site cadence, deliberately: callers already invoke {@code emit}
     * every cycle in practice, but this shouldn't depend on that staying
     * true for every current and future call site.
     */
    @Scheduled(fixedDelayString = "#{${flighttracker.observability.phase-heartbeat-seconds:240} * 1000}")
    void heartbeat() {
        touchHeartbeatFile();
        String phase = current.get();
        if (phase == null) {
            return; // constructor hasn't run yet — shouldn't happen, but nothing to re-print
        }
        if (Duration.between(lastPrintedAt, Instant.now()).getSeconds() < heartbeatSeconds) {
            return; // a transition already printed recently enough
        }
        print(phase, currentDetail.get());
    }

    private void print(String phase, String detail) {
        lastPrintedAt = Instant.now();
        if (detail == null || detail.isBlank()) {
            log.info("[phase:{}]", phase);
        } else {
            log.info("[phase:{}] {}", phase, detail);
        }
    }

    /**
     * Best-effort — a failed write here shouldn't break phase logging
     * itself. /tmp always exists and is writable in the runtime container
     * image (eclipse-temurin-alpine), so a failure here would mean
     * something more seriously wrong with the container.
     */
    private void touchHeartbeatFile() {
        try {
            Files.writeString(HEARTBEAT_FILE, Instant.now().toString());
        } catch (IOException ignored) {
        }
    }

    /** The phase last emitted, or null if none has been. For tests. */
    public String currentPhase() {
        return current.get();
    }
}
