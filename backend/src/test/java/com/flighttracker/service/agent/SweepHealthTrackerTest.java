package com.flighttracker.service.agent;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * lastSweepAt is a freshness claim, so it may only move on a sweep that
 * actually wrote rows — a skipped or empty cycle is not "fresh data".
 */
class SweepHealthTrackerTest {

    @Test
    void aSweepThatWroteNothing_doesNotAdvanceLastSweepAt() {
        SweepHealthTracker tracker = new SweepHealthTracker();

        tracker.recordSweepCompleted(0);

        assertThat(tracker.lastSweepAt()).isEmpty();
        assertThat(tracker.lastSweepRows()).isZero();
        assertThat(tracker.consecutiveSkips()).isEqualTo(1);
    }

    @Test
    void consecutiveEmptySweeps_keepCounting_butLeaveTheStampAlone() {
        SweepHealthTracker tracker = new SweepHealthTracker();
        tracker.recordSweepCompleted(12); // a real sweep first
        var stamped = tracker.lastSweepAt();

        tracker.recordSweepCompleted(0);
        tracker.recordSweepCompleted(0);

        assertThat(tracker.lastSweepAt()).isEqualTo(stamped); // unchanged by the empty cycles
        assertThat(tracker.consecutiveSkips()).isEqualTo(2);
    }

    @Test
    void aProductiveSweep_stampsTheTime_recordsTheRows_andClearsTheSkips() {
        SweepHealthTracker tracker = new SweepHealthTracker();
        tracker.recordSweepCompleted(0);
        tracker.recordSweepCompleted(0);

        tracker.recordSweepCompleted(13_042);

        assertThat(tracker.lastSweepAt()).isPresent();
        assertThat(tracker.lastSweepRows()).isEqualTo(13_042);
        assertThat(tracker.consecutiveSkips()).isZero();
    }
}
