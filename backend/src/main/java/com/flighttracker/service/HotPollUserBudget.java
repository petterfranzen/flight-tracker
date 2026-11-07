package com.flighttracker.service;

import com.flighttracker.repository.AppStateRepository;
import jakarta.annotation.PostConstruct;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.time.Clock;
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
    // own memory use over time; sweep() also forgets IPs with nothing left
    // in the window (and their app_state row), so the key set stays bounded
    // (security review #143 L8). Entries change only inside compute*(),
    // atomic per key, so a sweep can't discard a grant being recorded.
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

    private final Clock clock;

    @Autowired
    public HotPollUserBudget(AppStateRepository appState,
                              @Value("${flighttracker.rate-limit.hot-poll-seconds-per-ip-per-day}") long dailyCapSeconds,
                              Clock clock) {
        this.appState = appState;
        this.dailyCapSeconds = dailyCapSeconds;
        this.clock = clock;
    }

    public HotPollUserBudget(AppStateRepository appState, long dailyCapSeconds) {
        this(appState, dailyCapSeconds, Clock.systemUTC());
    }

    /** Number of IPs currently tracked (for tests and diagnostics). */
    int trackedIps() {
        return grantsByIp.size();
    }

    /** Drops grants older than 24h and forgets IPs with none left, including their persisted row. */
    @Scheduled(fixedDelayString = "${flighttracker.rate-limit.sweep-interval-ms:600000}")
    void sweep() {
        Instant dayAgo = clock.instant().minus(Duration.ofDays(1));
        for (String ip : grantsByIp.keySet()) {
            grantsByIp.computeIfPresent(ip, (k, history) -> {
                boolean changed = false;
                while (!history.isEmpty() && history.peekFirst().at().isBefore(dayAgo)) {
                    history.pollFirst();
                    changed = true;
                }
                if (history.isEmpty()) {
                    appState.delete(KEY_PREFIX + ip);
                    return null;
                }
                if (changed) persist(ip, history);
                return history;
            });
        }
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

        Instant now = clock.instant();
        boolean[] granted = {false};
        grantsByIp.compute(ip, (k, existing) -> {
            Deque<Grant> history = existing != null ? existing : new ArrayDeque<>();
            Instant dayAgo = now.minus(Duration.ofDays(1));
            while (!history.isEmpty() && history.peekFirst().at().isBefore(dayAgo)) {
                history.pollFirst();
            }

            long usedToday = history.stream().mapToLong(Grant::seconds).sum();
            if (usedToday + grantSeconds <= dailyCapSeconds) {
                history.addLast(new Grant(now, grantSeconds));
                granted[0] = true;
                persist(ip, history);
            }
            return history.isEmpty() ? null : history;
        });
        return granted[0];
    }

    private void persist(String ip, Deque<Grant> history) {
        String encoded = history.stream().map(Grant::encode).reduce((a, b) -> a + "," + b).orElse("");
        appState.put(KEY_PREFIX + ip, encoded);
    }
}
