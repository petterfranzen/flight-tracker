package com.flighttracker.service;

import com.flighttracker.dto.PollingStatus;
import com.flighttracker.repository.AppStateRepository;
import org.junit.jupiter.api.Test;

import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;

/**
 * The shared window is held open by per-key grants, and the restart quota is
 * charged per key (finding M1, section9-hq #405): a single client must not be
 * able to close the window for everyone with an unauthenticated stop, nor
 * spend a shared quota and lock every other visitor out of reopening it.
 */
class PollWindowServiceTest {

    private final AppStateRepository appState = mock(AppStateRepository.class);

    private PollWindowService window(int quotaMax) {
        return new PollWindowService(appState, 300, quotaMax, 15, 3000);
    }

    @Test
    void stopReleasesOnlyTheCallersGrant() {
        PollWindowService window = window(3);
        window.restart("key-a", false);
        window.restart("key-b", false);

        window.stop("key-a");
        assertThat(window.isActive()).as("key-b's grant keeps the window open").isTrue();

        window.stop("key-b");
        assertThat(window.isActive()).isFalse();
    }

    @Test
    void stopOfAKeyWithNoGrantLeavesOtherGrantsAlone() {
        PollWindowService window = window(3);
        window.restart("key-a", false);

        window.stop("never-opened");

        assertThat(window.isActive()).isTrue();
    }

    @Test
    void theRestartQuotaIsChargedPerKey_notGlobally() {
        PollWindowService window = window(3);

        assertThat(window.restart("key-a", false)).isEmpty();
        assertThat(window.restart("key-a", false)).isEmpty();
        assertThat(window.restart("key-a", false)).isEmpty();
        assertThat(window.restart("key-a", false)).as("key-a's 4th reopen in the window is refused").isPresent();

        assertThat(window.restart("key-b", false)).as("key-b's quota is untouched by key-a's burst").isEmpty();
    }

    @Test
    void aRefusedReopenReturnsWhenTheQuotaResets() {
        PollWindowService window = window(1);
        window.restart("key-a", false);

        Optional<java.time.Instant> reset = window.restart("key-a", false);

        assertThat(reset).isPresent();
        assertThat(reset.get()).isAfter(java.time.Instant.now());
    }

    @Test
    void bypassQuotaReopensWithoutConsumingAnyQuota() {
        PollWindowService window = window(1);

        // The boot-time seed ("boot") and local callers pass true; neither
        // should ever hit the quota, however often they call.
        for (int i = 0; i < 5; i++) {
            assertThat(window.restart(true)).isEmpty();
        }
        assertThat(window.isActive()).isTrue();
    }

    @Test
    void statusTracksTheLatestLiveGrant() {
        PollWindowService window = window(3);

        assertThat(window.status().active()).isFalse();
        assertThat(window.status().secondsRemaining()).isZero();

        window.restart("key-a", false);
        PollingStatus status = window.status();
        assertThat(status.active()).isTrue();
        assertThat(status.secondsRemaining()).isBetween(290L, 300L);
    }
}
