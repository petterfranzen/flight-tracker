package com.flighttracker.service;

import com.flighttracker.repository.AppStateRepository;
import org.junit.jupiter.api.Test;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;

/** Security review #143 L8: the per-IP maps forget idle IPs instead of growing forever. */
class RateLimitPruningTest {

    /** A clock the test moves by hand. */
    static final class MutableClock extends Clock {
        private Instant now = Instant.parse("2026-11-07T12:00:00Z");

        void advance(Duration d) {
            now = now.plus(d);
        }

        @Override public java.time.ZoneId getZone() { return ZoneOffset.UTC; }
        @Override public Clock withZone(java.time.ZoneId zone) { return this; }
        @Override public Instant instant() { return now; }
    }

    @Test
    void restartLimiterSweepDropsIpsIdleForADay_andKeepsRecentOnes() {
        MutableClock clock = new MutableClock();
        RestartRateLimiter limiter = new RestartRateLimiter(3, 20, clock);

        for (int i = 0; i < 1_000; i++) limiter.checkAndRecord("198.51.100." + (i % 250) + "-" + i, false);
        assertThat(limiter.trackedIps()).isEqualTo(1_000);

        clock.advance(Duration.ofHours(23));
        limiter.checkAndRecord("203.0.113.9", false); // recent
        limiter.sweep();
        assertThat(limiter.trackedIps()).as("nothing is old enough yet").isEqualTo(1_001);

        clock.advance(Duration.ofHours(2)); // the 1,000 are now 25h old, the recent one 2h
        limiter.sweep();
        assertThat(limiter.trackedIps()).isEqualTo(1);
    }

    @Test
    void restartLimiterStillEnforcesLimitsAfterASweep() {
        MutableClock clock = new MutableClock();
        RestartRateLimiter limiter = new RestartRateLimiter(3, 20, clock);
        for (int i = 0; i < 3; i++) assertThat(limiter.checkAndRecord("203.0.113.9", false)).isEmpty();
        limiter.sweep();
        assertThat(limiter.checkAndRecord("203.0.113.9", false)).hasValue("too many requests this minute");
    }

    @Test
    void restartLimiterDoesNotRetainIpsItRefuses() {
        RestartRateLimiter limiter = new RestartRateLimiter(3, 0, new MutableClock()); // 0/day: always refused
        for (int i = 0; i < 100; i++) assertThat(limiter.checkAndRecord("198.51.100." + i, false)).isPresent();
        assertThat(limiter.trackedIps()).isZero();
    }

    @Test
    void hotPollBudgetSweepDropsIdleIpsAndTheirPersistedRows() {
        MutableClock clock = new MutableClock();
        AppStateRepository appState = mock(AppStateRepository.class);
        HotPollUserBudget budget = new HotPollUserBudget(appState, 4500, clock);

        for (int i = 0; i < 500; i++) assertThat(budget.tryGrant("198.51.100." + i, false, 300)).isTrue();
        assertThat(budget.trackedIps()).isEqualTo(500);

        clock.advance(Duration.ofHours(23));
        assertThat(budget.tryGrant("203.0.113.9", false, 300)).isTrue();
        budget.sweep();
        assertThat(budget.trackedIps()).isEqualTo(501);

        clock.advance(Duration.ofHours(2));
        budget.sweep();
        assertThat(budget.trackedIps()).isEqualTo(1);
        verify(appState).delete("hotpoll.ip.198.51.100.0");
        verify(appState).delete("hotpoll.ip.198.51.100.499");
    }

    @Test
    void hotPollBudgetStillEnforcesTheCapAfterASweep() {
        MutableClock clock = new MutableClock();
        HotPollUserBudget budget = new HotPollUserBudget(mock(AppStateRepository.class), 600, clock);
        assertThat(budget.tryGrant("203.0.113.9", false, 300)).isTrue();
        assertThat(budget.tryGrant("203.0.113.9", false, 300)).isTrue();
        budget.sweep();
        assertThat(budget.tryGrant("203.0.113.9", false, 300)).isFalse();
        clock.advance(Duration.ofHours(25));
        assertThat(budget.tryGrant("203.0.113.9", false, 300)).isTrue();
    }
}
