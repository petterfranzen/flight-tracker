package com.flighttracker.service.coverage;

import com.flighttracker.dto.Bounds;
import org.springframework.stereotype.Component;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

/**
 * Remembers which parts of the world a data poll recently covered, so an
 * aircraft that was inside a covered area but missing from the answer can be
 * told apart from one that simply hasn't been asked about since. The global
 * sweep covers everything; a hot poll covers the viewport it was made for.
 *
 * <p>AgentOrchestrator records a poll only when it returned at least one
 * report, because a failed poll (throttled, backing off, timeout) also
 * returns an empty list and must not count as "nothing there".
 *
 * <p>Thread-safe: recording replaces an immutable snapshot, readers (the
 * estimator asks once per airborne aircraft) never lock.
 */
@Component
public class PollCoverageTracker {

    /** Hot polls older than this no longer say anything about where an aircraft is. */
    static final Duration HOT_POLL_MEMORY = Duration.ofMinutes(15);
    static final int MAX_HOT_POLLS = 200;

    private record HotPoll(Instant completedAt, Bounds bounds) { }

    private final Object writeLock = new Object();
    private volatile Instant lastGlobal; // null until the first sweep
    private volatile List<HotPoll> hotPolls = List.of(); // oldest first

    /** @param bounds the area the poll covered, or null for a global sweep */
    public void recordPoll(Instant completedAt, Bounds bounds) {
        synchronized (writeLock) {
            if (bounds == null) {
                if (lastGlobal == null || completedAt.isAfter(lastGlobal)) lastGlobal = completedAt;
                return;
            }
            Instant keepFrom = completedAt.minus(HOT_POLL_MEMORY);
            List<HotPoll> next = new ArrayList<>(hotPolls.size() + 1);
            for (HotPoll p : hotPolls) {
                if (p.completedAt().isAfter(keepFrom)) next.add(p);
            }
            next.add(new HotPoll(completedAt, bounds));
            if (next.size() > MAX_HOT_POLLS) next.subList(0, next.size() - MAX_HOT_POLLS).clear();
            hotPolls = List.copyOf(next);
        }
    }

    /** Latest completion among the last global sweep and the remembered hot polls that contain the point. */
    public Optional<Instant> lastCoveringPollAt(double lat, double lon) {
        Instant best = lastGlobal;
        for (HotPoll p : hotPolls) {
            if ((best == null || p.completedAt().isAfter(best)) && p.bounds().contains(lat, lon)) {
                best = p.completedAt();
            }
        }
        return Optional.ofNullable(best);
    }
}
