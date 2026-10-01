package com.flighttracker.controller;

import com.flighttracker.dto.HealthStatus;
import com.flighttracker.service.agent.SweepHealthTracker;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;

import static org.assertj.core.api.Assertions.assertThat;
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
        return new HealthController(jdbcTemplate, sweepHealthTracker, buildProperties, globalSweepIntervalSeconds);
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
        sweepHealthTracker.recordSweepCompleted();

        assertThat(controller(360).sweepHealth().getStatusCode().value()).isEqualTo(200);
    }

    @Test
    void sweepHealth_staleSweep_beyondThreeIntervals_returns503() throws InterruptedException {
        // A 0-second interval means "3x the interval" is already elapsed
        // the instant recordSweepCompleted() returns — the simplest way to
        // exercise the "gone stale" branch without sleeping for real time.
        sweepHealthTracker.recordSweepCompleted();
        Thread.sleep(5);

        assertThat(controller(0).sweepHealth().getStatusCode().value()).isEqualTo(503);
    }
}
