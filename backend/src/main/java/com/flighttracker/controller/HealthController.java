package com.flighttracker.controller;

import com.flighttracker.dto.HealthStatus;
import com.flighttracker.service.agent.SweepHealthTracker;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.info.BuildProperties;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.time.Duration;
import java.time.Instant;

/**
 * Additive-only endpoints (frozen HTTP contract, PLAN.md §2.1) added for
 * cloud migration A1 (§6 item 11) — deploy.sh polls GET /api/health after
 * every deploy and waits for its version field to equal the SHA it just
 * shipped before considering the release healthy.
 */
@RestController
@RequestMapping("/api/health")
public class HealthController {

    private final JdbcTemplate jdbcTemplate;
    private final SweepHealthTracker sweepHealthTracker;
    private final ObjectProvider<BuildProperties> buildProperties;
    private final long globalSweepIntervalSeconds;

    public HealthController(JdbcTemplate jdbcTemplate,
                             SweepHealthTracker sweepHealthTracker,
                             ObjectProvider<BuildProperties> buildProperties,
                             @Value("${flighttracker.agents.global-sweep-interval-seconds:360}") long globalSweepIntervalSeconds) {
        this.jdbcTemplate = jdbcTemplate;
        this.sweepHealthTracker = sweepHealthTracker;
        this.buildProperties = buildProperties;
        this.globalSweepIntervalSeconds = globalSweepIntervalSeconds;
    }

    /**
     * 200 when both the app is answering (trivially true, or this
     * wouldn't run) and the database is: a plain SELECT 1, cheap enough to
     * run on every health check, and the actual thing deploy.sh's rollback
     * decision needs to know about — a jar that's up but can't reach
     * Postgres isn't a healthy deploy. Deliberately does not touch OpenSky
     * in any way: this app's own dependency, not an external one outside
     * its control, and a deploy must not fail (or be rolled back) just
     * because OpenSky happens to be down or rate-limiting at that exact
     * moment.
     *
     * version is read from Spring Boot's BuildProperties, which only
     * exists when the build-info Maven goal ran (see ci-deployer's work
     * package) — absent in a local/backend-only build, where this falls
     * back to "dev" rather than failing.
     */
    @GetMapping
    public ResponseEntity<HealthStatus> health() {
        boolean dbUp = isDatabaseReachable();
        BuildProperties build = buildProperties.getIfAvailable();
        String gitSha = build == null ? null : build.get("git.sha");
        String version = (gitSha == null || gitSha.isBlank()) ? "dev" : gitSha;
        Instant lastSweepAt = sweepHealthTracker.lastSweepAt().orElse(null);
        HealthStatus status = new HealthStatus(dbUp ? "UP" : "DOWN", version, dbUp ? "UP" : "DOWN", lastSweepAt);
        return dbUp ? ResponseEntity.ok(status) : ResponseEntity.status(503).body(status);
    }

    private boolean isDatabaseReachable() {
        try {
            jdbcTemplate.queryForObject("SELECT 1", Integer.class);
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * Monitoring-only, not a deploy gate: 200 while the global sweep has
     * completed within the last 3× its own interval, 503 once it's gone
     * quiet longer than that (the scheduler pool has stalled, every
     * FlightDataAgent is failing outright, etc — see SweepHealthTracker).
     * 3× rather than 1×: an occasional slow or skipped cycle (OpenSky
     * backing off, a transient DB hiccup) is normal operation, not an
     * incident; this only fires once the pattern looks like the sweep has
     * actually stopped running, not just run late once.
     */
    @GetMapping("/sweep")
    public ResponseEntity<Void> sweepHealth() {
        boolean healthy = sweepHealthTracker.lastSweepAt()
                .map(lastSweepAt -> Duration.between(lastSweepAt, Instant.now()).toSeconds() < globalSweepIntervalSeconds * 3)
                .orElse(false);
        return healthy ? ResponseEntity.ok().build() : ResponseEntity.status(503).build();
    }
}
