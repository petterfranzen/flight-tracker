package com.flighttracker.service;

import com.flighttracker.repository.AppStateRepository;
import jakarta.annotation.PostConstruct;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.Map;
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
 * Cloud migration A1 (PLAN.md §6 item 6): "the original design requirement"
 * is that this budget — like the global hot-poll-daily-call-budget in
 * PollWindowService — survive a process restart, so each IP's grant
 * history is write-through persisted to the small app_state table
 * (AppStateRepository, key {@code "hotpoll.ip.<ip>"}), and every distinct
 * IP's history is reloaded at startup. The in-memory ConcurrentHashMap is
 * still the source of truth for every read/check — app_state only exists
 * so that map isn't empty again after a restart.
 */
@Component
public class HotPollUserBudget {

    private static final String KEY_PREFIX = "hotpoll.ip.";

    private final AppStateRepository appState;
    private final long dailyCapSeconds;

    // One deque of (grant instant, seconds granted) per IP, oldest first —
    // pruned to the last 24h on every check, which also bounds each IP's
    // own memory use over time. See RestartRateLimiter's javadoc for why
    // the outer map's key set isn't itself pruned.
    private final ConcurrentHashMap<String, Deque<Grant>> grantsByIp = new ConcurrentHashMap<>();

    private record Grant(Instant at, long seconds) {
        String encode() {
            return at.toEpochMilli() + ":" + seconds;
        }

        static Grant decode(String s) {
            int i = s.indexOf(':');
            return new Grant(Instant.ofEpochMilli(Long.parseLong(s.substring(0, i))), Long.parseLong(s.substring(i + 1)));
        }
    }

    public HotPollUserBudget(AppStateRepository appState,
                              @Value("${flighttracker.rate-limit.hot-poll-seconds-per-ip-per-day}") long dailyCapSeconds) {
        this.appState = appState;
        this.dailyCapSeconds = dailyCapSeconds;
    }

    @PostConstruct
    void loadFromAppState() {
        Map<String, String> rows = appState.getAllWithPrefix(KEY_PREFIX);
        for (var entry : rows.entrySet()) {
            String ip = entry.getKey().substring(KEY_PREFIX.length());
            Deque<Grant> history = new ArrayDeque<>();
            for (String encoded : entry.getValue().split(",")) {
                if (!encoded.isBlank()) history.addLast(Grant.decode(encoded));
            }
            if (!history.isEmpty()) grantsByIp.put(ip, history);
        }
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
        boolean granted;
        synchronized (history) {
            Instant dayAgo = now.minus(Duration.ofDays(1));
            while (!history.isEmpty() && history.peekFirst().at().isBefore(dayAgo)) {
                history.pollFirst();
            }

            long usedToday = history.stream().mapToLong(Grant::seconds).sum();
            if (usedToday + grantSeconds > dailyCapSeconds) {
                granted = false;
            } else {
                history.addLast(new Grant(now, grantSeconds));
                granted = true;
            }
            if (granted) {
                persist(ip, history);
            }
        }
        return granted;
    }

    private void persist(String ip, Deque<Grant> history) {
        String encoded = history.stream().map(Grant::encode).reduce((a, b) -> a + "," + b).orElse("");
        appState.put(KEY_PREFIX + ip, encoded);
    }
}
