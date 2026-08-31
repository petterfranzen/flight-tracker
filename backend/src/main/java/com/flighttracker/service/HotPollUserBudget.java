package com.flighttracker.service;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Per-client-IP daily cap on hot-poll *time*, not requests — separate
 * from (and in addition to) RestartRateLimiter, which throttles how often
 * an IP may call POST /api/agents/restart at all. That one stops sustained
 * hammering of the endpoint; this one bounds how many seconds of actual
 * 18s hot polling a single caller can rack up across a rolling 24h, since
 * a caller well under RestartRateLimiter's request-count limits could
 * still keep re-granting the maximum poll-window-seconds back to back all
 * day otherwise.
 *
 * In-memory, same reasoning as RestartRateLimiter: this app runs as a
 * single "api" container instance, so there's no second instance for this
 * state to be inconsistent with, and a restart resetting everyone's daily
 * usage is an acceptable, rare edge case rather than something worth
 * making DB-backed.
 */
@Component
public class HotPollUserBudget {

    private final long dailyCapSeconds;

    // One deque of (grant instant, seconds granted) per IP, oldest first —
    // pruned to the last 24h on every check, which also bounds each IP's
    // own memory use over time. See RestartRateLimiter's javadoc for why
    // the outer map's key set isn't itself pruned.
    private final ConcurrentHashMap<String, Deque<Grant>> grantsByIp = new ConcurrentHashMap<>();

    private record Grant(Instant at, long seconds) {
    }

    public HotPollUserBudget(@Value("${flighttracker.rate-limit.hot-poll-seconds-per-ip-per-day}") long dailyCapSeconds) {
        this.dailyCapSeconds = dailyCapSeconds;
    }

    /**
     * @param isLocal      see ClientIpResolver.isLocal — local callers are exempt entirely.
     * @param grantSeconds how many seconds this particular grant would add (poll-window-seconds).
     * @return true if this IP has room left today and the grant was recorded; false if granting it
     *         would push this IP over dailyCapSeconds for the last 24h — the caller should not open
     *         (or extend) the poll window in that case.
     */
    public boolean tryGrant(String ip, boolean isLocal, long grantSeconds) {
        if (isLocal) return true;

        Instant now = Instant.now();
        Deque<Grant> history = grantsByIp.computeIfAbsent(ip, k -> new ArrayDeque<>());
        synchronized (history) {
            Instant dayAgo = now.minus(Duration.ofDays(1));
            while (!history.isEmpty() && history.peekFirst().at().isBefore(dayAgo)) {
                history.pollFirst();
            }

            long usedToday = history.stream().mapToLong(Grant::seconds).sum();
            if (usedToday + grantSeconds > dailyCapSeconds) {
                return false;
            }

            history.addLast(new Grant(now, grantSeconds));
        }
        return true;
    }
}
