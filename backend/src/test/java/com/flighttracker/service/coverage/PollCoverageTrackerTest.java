package com.flighttracker.service.coverage;

import com.flighttracker.dto.Bounds;
import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.time.Instant;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;

class PollCoverageTrackerTest {

    private static final Instant T0 = Instant.parse("2026-10-12T12:00:00Z");
    private static final Bounds SWEDEN = new Bounds(55, 69, 10, 25);

    private final PollCoverageTracker tracker = new PollCoverageTracker();

    @Test
    void nothingRecorded_nothingCovers() {
        assertThat(tracker.lastCoveringPollAt(59, 18)).isEmpty();
    }

    @Test
    void globalSweep_coversEverywhere() {
        tracker.recordPoll(T0, null);

        assertThat(tracker.lastCoveringPollAt(59, 18)).contains(T0);
        assertThat(tracker.lastCoveringPollAt(-33, 151)).contains(T0);
    }

    @Test
    void hotPoll_coversOnlyItsBounds_andTheNewestCoveringPollWins() {
        tracker.recordPoll(T0, null);
        tracker.recordPoll(T0.plusSeconds(100), SWEDEN);

        assertThat(tracker.lastCoveringPollAt(59, 18)).contains(T0.plusSeconds(100));
        assertThat(tracker.lastCoveringPollAt(40, 18)).contains(T0); // outside the hot poll: the sweep
    }

    @Test
    void olderHotPollNeverHidesANewerGlobalSweep() {
        tracker.recordPoll(T0, SWEDEN);
        tracker.recordPoll(T0.plusSeconds(50), null);

        assertThat(tracker.lastCoveringPollAt(59, 18)).contains(T0.plusSeconds(50));
    }

    @Test
    void hotPollsAreForgottenAfterTheMemoryWindow() {
        tracker.recordPoll(T0, SWEDEN);
        tracker.recordPoll(T0.plus(PollCoverageTracker.HOT_POLL_MEMORY).plusSeconds(1), new Bounds(0, 1, 0, 1));

        assertThat(tracker.lastCoveringPollAt(59, 18)).isEmpty();
    }

    @Test
    void hotPollsAreBoundedInNumber() {
        tracker.recordPoll(T0, SWEDEN); // the oldest of more than MAX_HOT_POLLS, all within the memory window
        for (int i = 1; i <= PollCoverageTracker.MAX_HOT_POLLS; i++) {
            tracker.recordPoll(T0.plusSeconds(i), new Bounds(0, 1, 0, 1));
        }

        assertThat(tracker.lastCoveringPollAt(59, 18)).isEmpty();
        assertThat(tracker.lastCoveringPollAt(0.5, 0.5)).contains(T0.plusSeconds(PollCoverageTracker.MAX_HOT_POLLS));
    }

    @Test
    void concurrentRecordingAndReading_isSafe() throws Exception {
        ExecutorService pool = Executors.newFixedThreadPool(4);
        for (int t = 0; t < 4; t++) {
            int worker = t;
            pool.submit(() -> {
                for (int i = 0; i < 500; i++) {
                    tracker.recordPoll(T0.plus(Duration.ofMillis(worker * 1000L + i)), i % 10 == 0 ? null : SWEDEN);
                    tracker.lastCoveringPollAt(59, 18);
                }
            });
        }
        pool.shutdown();
        assertThat(pool.awaitTermination(30, TimeUnit.SECONDS)).isTrue();
        assertThat(tracker.lastCoveringPollAt(59, 18)).isPresent();
    }
}
