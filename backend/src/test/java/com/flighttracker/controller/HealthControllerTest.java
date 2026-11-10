package com.flighttracker.controller;

import com.flighttracker.dto.HealthStatus;
import com.flighttracker.service.agent.SweepHealthTracker;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.boot.info.BuildProperties;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.Optional;
import java.util.Properties;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * GET /api/health and /api/health/sweep — additive-only endpoints added
 * for cloud migration A1 (PLAN.md §6 item 11). No Spring context: a real
 * SweepHealthTracker (cheap, no dependencies of its own) rather than a
 * mock, since its actual elapsed-time arithmetic is part of what
 * /sweep's 3×-interval threshold is meant to verify.
 */
@ExtendWith(MockitoExtension.class)
class HealthControllerTest {

    @Mock
    private JdbcTemplate jdbcTemplate;
    @Mock
    private ObjectProvider<org.springframework.boot.info.BuildProperties> buildProperties;

    private final SweepHealthTracker sweepHealthTracker = new SweepHealthTracker();

    private HealthController controller(long globalSweepIntervalSeconds) {
        // The production clock (ClockConfig's bean); the tests that need a pinned
        // "now" build their own controller with a fixed one below.
        return new HealthController(jdbcTemplate, sweepHealthTracker, buildProperties,
                globalSweepIntervalSeconds, Clock.systemUTC());
    }

    @Test
    void health_dbReachable_returns200WithUpStatusAndDevVersionFallback() {
        when(jdbcTemplate.queryForObject("SELECT 1", Integer.class)).thenReturn(1);
        when(buildProperties.getIfAvailable()).thenReturn(null); // no build-info in this build — see the endpoint's own javadoc

        ResponseEntity<HealthStatus> response = controller(360).health();

        assertThat(response.getStatusCode().value()).isEqualTo(200);
        assertThat(response.getBody().status()).isEqualTo("UP");
        assertThat(response.getBody().db()).isEqualTo("UP");
        assertThat(response.getBody().version()).isEqualTo("dev");
    }

    @Test
    void health_dbUnreachable_returns503WithDownStatus() {
        when(jdbcTemplate.queryForObject("SELECT 1", Integer.class)).thenThrow(new RuntimeException("connection refused"));
        when(buildProperties.getIfAvailable()).thenReturn(null);

        ResponseEntity<HealthStatus> response = controller(360).health();

        assertThat(response.getStatusCode().value()).isEqualTo(503);
        assertThat(response.getBody().status()).isEqualTo("DOWN");
        assertThat(response.getBody().db()).isEqualTo("DOWN");
    }

    @Test
    void sweepHealth_neverSwept_returns503() {
        assertThat(controller(360).sweepHealth().getStatusCode().value()).isEqualTo(503);
    }

    @Test
    void sweepHealth_recentSweep_returns200() {
        sweepHealthTracker.recordSweepCompleted(5);

        assertThat(controller(360).sweepHealth().getStatusCode().value()).isEqualTo(200);
    }

    // ---- version: exactly the injected git.sha

    private static BuildProperties buildPropertiesWithSha(String sha) {
        Properties p = new Properties();
        if (sha != null) p.setProperty("git.sha", sha);
        return new BuildProperties(p);
    }

    @Test
    void health_version_isExactlyTheInjectedGitSha() {
        String sha = "3f9c1d2e4b5a69788796a5b4c3d2e1f001122334";
        when(jdbcTemplate.queryForObject("SELECT 1", Integer.class)).thenReturn(1);
        when(buildProperties.getIfAvailable()).thenReturn(buildPropertiesWithSha(sha));

        assertThat(controller(360).health().getBody().version()).isEqualTo(sha);
    }

    @Test
    void health_version_fallsBackToDevWhenTheShaIsMissingOrBlank() {
        when(jdbcTemplate.queryForObject("SELECT 1", Integer.class)).thenReturn(1);
        when(buildProperties.getIfAvailable()).thenReturn(buildPropertiesWithSha(null), buildPropertiesWithSha("  "));

        assertThat(controller(360).health().getBody().version()).isEqualTo("dev");
        assertThat(controller(360).health().getBody().version()).isEqualTo("dev");
    }

    @Test
    void health_version_matchesTheShaThisJarWasBuiltWith() throws Exception {
        // The real build-info.properties the Maven build wrote (the same file the jar carries),
        // against the -Dgit.sha the build was given: CI passes the commit SHA, a local build
        // passes nothing and the pom default "dev" applies. Surefire forwards -D user properties.
        Properties file = new Properties();
        try (var in = getClass().getResourceAsStream("/META-INF/build-info.properties")) {
            assertThat(in).as("build-info.properties is generated by the build-info goal").isNotNull();
            file.load(in);
        }
        // Boot's own loader strips the "build." prefix before building BuildProperties; do the same.
        Properties built = new Properties();
        file.stringPropertyNames().stream().filter(k -> k.startsWith("build."))
                .forEach(k -> built.setProperty(k.substring("build.".length()), file.getProperty(k)));
        assertThat(built.getProperty("git.sha")).as("build-info carries git.sha").isNotBlank();
        String expected = System.getProperty("git.sha", "dev");
        when(jdbcTemplate.queryForObject("SELECT 1", Integer.class)).thenReturn(1);
        when(buildProperties.getIfAvailable()).thenReturn(new BuildProperties(built));

        assertThat(controller(360).health().getBody().version()).isEqualTo(expected);
    }

    // ---- /sweep: 200 inside 3x the interval, 503 beyond it, at the boundary either side

    /**
     * "Now" for the /sweep boundary tests. Pinned through the injected Clock, so the
     * age of the sweep is exact — no {@code Instant.now()} in the test, no sleep, and
     * no margin for the app's own clock to drift across the threshold mid-assertion.
     */
    private static final Instant NOW = Instant.parse("2026-10-12T12:00:00Z");
    private static final Clock CLOCK_AT_NOW = Clock.fixed(NOW, ZoneOffset.UTC);

    /** A controller whose real SweepHealthTracker is replaced by a stub reporting this stamp. */
    private HealthController controllerWithLastSweep(Instant lastSweepAt, long intervalSeconds) {
        SweepHealthTracker tracker = mock(SweepHealthTracker.class);
        when(tracker.lastSweepAt()).thenReturn(Optional.ofNullable(lastSweepAt));
        return new HealthController(jdbcTemplate, tracker, buildProperties, intervalSeconds, CLOCK_AT_NOW);
    }

    // 60s interval => the 3x threshold is exactly 180s; each case sits one second
    // inside, exactly on, and one second past it (the check is a strict "<", so the
    // boundary itself already counts as stale).

    @Test
    void sweepHealth_justInsideThreeIntervals_returns200() {
        Instant lastSweep = NOW.minus(Duration.ofSeconds(3 * 60 - 1));
        assertThat(controllerWithLastSweep(lastSweep, 60).sweepHealth().getStatusCode().value()).isEqualTo(200);
    }

    @Test
    void sweepHealth_exactlyAtThreeIntervals_returns503() {
        Instant lastSweep = NOW.minus(Duration.ofSeconds(3 * 60));
        assertThat(controllerWithLastSweep(lastSweep, 60).sweepHealth().getStatusCode().value()).isEqualTo(503);
    }

    @Test
    void sweepHealth_justBeyondThreeIntervals_returns503() {
        Instant lastSweep = NOW.minus(Duration.ofSeconds(3 * 60 + 1));
        assertThat(controllerWithLastSweep(lastSweep, 60).sweepHealth().getStatusCode().value()).isEqualTo(503);
    }

    @Test
    void health_reportsTheSweepFreshnessFieldsTheSweepCheckReadsFrom() {
        when(jdbcTemplate.queryForObject("SELECT 1", Integer.class)).thenReturn(1);
        when(buildProperties.getIfAvailable()).thenReturn(null);
        HealthController before = controller(360);
        assertThat(before.health().getBody().lastSweepAt()).isNull();
        assertThat(before.sweepHealth().getStatusCode().value()).isEqualTo(503);

        sweepHealthTracker.recordSweepCompleted(7);
        assertThat(before.health().getBody().lastSweepAt()).isNotNull();
        assertThat(before.health().getBody().lastSweepRows()).isEqualTo(7);
        assertThat(before.sweepHealth().getStatusCode().value()).isEqualTo(200);
    }
}
