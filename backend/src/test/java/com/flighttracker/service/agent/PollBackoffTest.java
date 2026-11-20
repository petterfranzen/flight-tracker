package com.flighttracker.service.agent;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;

import java.time.Duration;
import java.time.Instant;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * PollBackoff's cooldown state machine. It stamps "until" from Instant.now(),
 * so the cooldown end is checked by bracketing the call, never by sleeping.
 */
class PollBackoffTest {

    private static final Duration MIN = Duration.ofSeconds(10);
    private static final Duration MAX = Duration.ofSeconds(120);

    @Test
    void freshBackoff_isNotCoolingDown() {
        PollBackoff backoff = new PollBackoff();

        assertThat(backoff.coolingDownUntil()).isEqualTo(Instant.EPOCH);
        assertThat(backoff.isCoolingDown(Instant.now())).isFalse();
    }

    @ParameterizedTest(name = "failure {0} waits {1} s")
    @CsvSource({"1, 10", "2, 20", "3, 40", "4, 80", "5, 120", "6, 120"})
    void consecutiveFailures_doubleTheWaitUpToTheCap(int failures, long expectedSeconds) {
        PollBackoff backoff = new PollBackoff();
        Duration wait = Duration.ZERO;
        for (int i = 0; i < failures; i++) {
            wait = backoff.recordFailure(MIN, MAX);
        }

        assertThat(wait).isEqualTo(Duration.ofSeconds(expectedSeconds));
    }

    @Test
    void doublingStopsAtSixteenTimesTheMinimum_evenUnderAHigherCap() {
        PollBackoff backoff = new PollBackoff();
        Duration wait = Duration.ZERO;
        for (int i = 0; i < 8; i++) {
            wait = backoff.recordFailure(MIN, Duration.ofHours(1));
        }

        assertThat(wait).isEqualTo(MIN.multipliedBy(16));
    }

    @Test
    void success_resetsTheEscalationButNotTheCurrentCooldown() {
        PollBackoff backoff = new PollBackoff();
        backoff.recordFailure(MIN, MAX);
        backoff.recordFailure(MIN, MAX);
        Instant until = backoff.coolingDownUntil();

        backoff.recordSuccess();

        assertThat(backoff.coolingDownUntil()).isEqualTo(until);
        assertThat(backoff.recordFailure(MIN, MAX)).isEqualTo(MIN);
    }

    @Test
    void failure_coolsDownFromNowForTheReturnedWait() {
        PollBackoff backoff = new PollBackoff();

        Instant before = Instant.now();
        Duration wait = backoff.recordFailure(MIN, MAX);
        Instant after = Instant.now();

        assertThat(backoff.coolingDownUntil()).isBetween(before.plus(wait), after.plus(wait));
        assertThat(backoff.isCoolingDown(after)).isTrue();
        assertThat(backoff.isCoolingDown(backoff.coolingDownUntil())).isFalse();
    }

    @Test
    void explicitWait_setsTheCooldownAndStillCountsAsAFailure() {
        PollBackoff backoff = new PollBackoff();

        Instant before = Instant.now();
        backoff.recordFailure(Duration.ofMinutes(5));
        Instant after = Instant.now();

        assertThat(backoff.coolingDownUntil()).isBetween(before.plusSeconds(300), after.plusSeconds(300));
        assertThat(backoff.recordFailure(MIN, MAX)).isEqualTo(MIN.multipliedBy(2));
    }
}
