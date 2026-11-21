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
import java.util.Arrays;
import java.util.Deque;
import java.util.concurrent.ConcurrentHashMap;
import java.util.stream.Collectors;

/**
 * Per-client-key daily cap on hot-poll *time*, not requests — separate
 * from (and in addition to) RestartRateLimiter, which throttles how often a
 * key may call POST /api/agents/restart at all. That one stops sustained
 * hammering of the endpoint; this one bounds how many seconds of actual hot
 * polling a single caller can rack up across a rolling 24h, since a caller
 * well under RestartRateLimiter's request-count limits could still keep
 * re-granting the maximum poll-window-seconds back to back all day
 * otherwise.
 *
 * <p>The key is the caller's {@link ClientIpResolver#rateLimitKey} — the /64
 * for IPv6 — so one IPv6 client cannot hold 2^64 identities (finding M3 of
 * the security audit, section9-hq #405).
 *
 * <p>Cloud migration A1 (PLAN.md §6 item 6): "the original design requirement"
 * is that this budget — like the global hot-poll-daily-call-budget in
 * PollWindowService — survive a process restart, so each key's grant history
 * is write-through persisted to the small app_state table
 * (AppStateRepository). What is stored is an <b>HMAC of the key</b>, not the
 * key itself (finding M3): the row is {@code "hotpoll.ip.<token>"} where
 * {@code token = HMAC-SHA256(flighttracker.rate-limit.ip-hash-pepper, key)},
 * so a raw client IP never lands in the database, and every distinct key's
 * history is reloaded at startup. The in-memory map is keyed by the same
 * token and stays the source of truth for every read/check — app_state only
 * exists so that map isn't empty again after a restart.
 */
@Component
public class HotPollUserBudget {

    private static final String KEY_PREFIX = "hotpoll.ip.";

    private final AppStateRepository appState;
    private final long dailyCapSeconds;
    private final String ipHashPepper;

    // One deque of (grant instant, seconds granted) per key token, oldest
    // first — pruned to the last 24h on every check, which also bounds each
    // key's own memory use over time; sweep() also forgets keys with nothing
    // left in the window (and their app_state row), so the key set stays
    // bounded (security review #143 L8). Entries change only inside
    // compute*(), atomic per key, so a sweep can't discard a grant being
    // recorded.
    private final ConcurrentHashMap<ClientKeyToken, Deque<Grant>> grantsByKey = new ConcurrentHashMap<>();

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
                              IpHashPepper ipHashPepper,
                              Clock clock) {
        this(appState, dailyCapSeconds, ipHashPepper.value(), clock);
    }

    /** For tests: they supply their own pepper instead of an {@link IpHashPepper}. */
    public HotPollUserBudget(AppStateRepository appState, long dailyCapSeconds, String ipHashPepper) {
        this(appState, dailyCapSeconds, ipHashPepper, Clock.systemUTC());
    }

    public HotPollUserBudget(AppStateRepository appState, long dailyCapSeconds, String ipHashPepper, Clock clock) {
        this.appState = appState;
        this.dailyCapSeconds = dailyCapSeconds;
        this.ipHashPepper = ipHashPepper;
        this.clock = clock;
    }

    /** Number of keys currently tracked (for tests and diagnostics). */
    int trackedIps() {
        return grantsByKey.size();
    }

    /** Drops grants older than 24h and forgets keys with none left, including their persisted row. */
    @Scheduled(fixedDelayString = "${flighttracker.rate-limit.sweep-interval-ms:600000}")
    void sweep() {
        Instant dayAgo = clock.instant().minus(Duration.ofDays(1));
        for (ClientKeyToken token : grantsByKey.keySet()) {
            grantsByKey.computeIfPresent(token, (k, history) -> {
                boolean changed = false;
                while (!history.isEmpty() && history.peekFirst().at().isBefore(dayAgo)) {
                    history.pollFirst();
                    changed = true;
                }
                if (history.isEmpty()) {
                    appState.delete(KEY_PREFIX + token.value());
                    return null;
                }
                if (changed) persist(token, history);
                return history;
            });
        }
    }

    @PostConstruct
    void loadFromAppState() {
        for (var entry : appState.getAllWithPrefix(KEY_PREFIX).entrySet()) {
            String suffix = entry.getKey().substring(KEY_PREFIX.length());
            if (ClientKeyToken.isToken(suffix)) {
                restore(new ClientKeyToken(suffix), entry.getValue());
            } else {
                // A row from before finding M3 is keyed by the raw client key, so
                // it can never match a token this version computes: dead weight
                // (and a raw address in the database) that would only linger until
                // the sweep pruned it. Delete it instead — idempotent and
                // additive-safe, since only a non-token suffix ever gets here.
                appState.delete(entry.getKey());
            }
        }
    }

    /** Reloads one row's grant history, ignoring it when it holds no grants. */
    private void restore(ClientKeyToken token, String encoded) {
        Deque<Grant> history = Arrays.stream(encoded.split(","))
                .filter(part -> !part.isBlank())
                .map(Grant::decode)
                .collect(Collectors.toCollection(ArrayDeque::new));
        if (!history.isEmpty()) {
            grantsByKey.put(token, history);
        }
    }

    /**
     * @param key          the caller's rate-limit key ({@link ClientIpResolver#rateLimitKey}).
     * @param isLocal      see ClientIpResolver.isLocal — local callers are exempt entirely.
     * @param grantSeconds how many seconds this particular grant would add (poll-window-seconds).
     * @return true if this key has room left today and the grant was recorded; false if granting it
     *         would push this key over dailyCapSeconds for the last 24h — the caller should not open
     *         (or extend) the poll window in that case.
     */
    public boolean tryGrant(String key, boolean isLocal, long grantSeconds) {
        if (isLocal) return true;

        ClientKeyToken token = ClientKeyToken.of(ipHashPepper, key);
        Instant now = clock.instant();
        boolean[] granted = {false};
        grantsByKey.compute(token, (k, existing) -> {
            Deque<Grant> history = existing != null ? existing : new ArrayDeque<>();
            Instant dayAgo = now.minus(Duration.ofDays(1));
            while (!history.isEmpty() && history.peekFirst().at().isBefore(dayAgo)) {
                history.pollFirst();
            }

            long usedToday = history.stream().mapToLong(Grant::seconds).sum();
            if (usedToday + grantSeconds <= dailyCapSeconds) {
                history.addLast(new Grant(now, grantSeconds));
                granted[0] = true;
                persist(token, history);
            }
            return history.isEmpty() ? null : history;
        });
        return granted[0];
    }

    private void persist(ClientKeyToken token, Deque<Grant> history) {
        String encoded = history.stream().map(Grant::encode).reduce((a, b) -> a + "," + b).orElse("");
        appState.put(KEY_PREFIX + token.value(), encoded);
    }
}
