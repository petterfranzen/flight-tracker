package com.flighttracker.service;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Per-client-IP limiter for POST /api/agents/restart specifically — the
 * one endpoint that costs real OpenSky usage. Separate from (and in
 * addition to) PollWindowService's global restart quota: that one
 * protects the shared OpenSky budget no matter who's asking; this one
 * stops a single caller from being the reason that shared quota gets
 * used up, and catches sustained abuse spread out *across* a day
 * specifically to dodge the global quota's 15-minute window (one request
 * every few minutes all day never trips a 15-minute cap, but it's still
 * exactly the kind of sustained usage worth blocking).
 *
 * In-memory: this app runs as a single "api" container instance (see
 * docker-compose.yml) — there's no second instance for this state to be
 * inconsistent across. A container restart resets it, which is fine; the
 * global quota this backs up is the one that actually has to survive
 * that, and it's DB-backed.
 */
@Component
public class RestartRateLimiter {

    private final int perMinuteMax;
    private final int perDayMax;

    // One deque of recent request timestamps per IP, oldest first. Pruned
    // to the last 24h on every check for that IP, and sweep() drops IPs
    // whose history has emptied, so the key set can't grow without bound
    // (security review #143 L8). Every read-modify-write of an entry runs
    // inside compute*(), which is atomic per key, so a sweep can't discard
    // a request being recorded.
    private final ConcurrentHashMap<String, Deque<Instant>> requestsByIp = new ConcurrentHashMap<>();

    private final Clock clock;

    @Autowired
    public RestartRateLimiter(@Value("${flighttracker.rate-limit.restart-per-ip-per-minute}") int perMinuteMax,
                               @Value("${flighttracker.rate-limit.restart-per-ip-per-day}") int perDayMax,
                               Clock clock) {
        this.perMinuteMax = perMinuteMax;
        this.perDayMax = perDayMax;
        this.clock = clock;
    }

    public RestartRateLimiter(int perMinuteMax, int perDayMax) {
        this(perMinuteMax, perDayMax, Clock.systemUTC());
    }

    /** Number of IPs currently tracked (for tests and diagnostics). */
    int trackedIps() {
        return requestsByIp.size();
    }

    /** Drops history older than 24h and forgets IPs with none left. */
    @Scheduled(fixedDelayString = "${flighttracker.rate-limit.sweep-interval-ms:600000}")
    void sweep() {
        Instant dayAgo = clock.instant().minus(Duration.ofDays(1));
        for (String ip : requestsByIp.keySet()) {
            requestsByIp.computeIfPresent(ip, (k, history) -> {
                while (!history.isEmpty() && history.peekFirst().isBefore(dayAgo)) {
                    history.pollFirst();
                }
                return history.isEmpty() ? null : history;
            });
        }
    }

    /**
     * @param isLocal see ClientIpResolver.isLocal — local callers are exempt entirely.
     * @return empty if allowed (the attempt is recorded); otherwise a short reason it was rejected.
     */
    public Optional<String> checkAndRecord(String ip, boolean isLocal) {
        if (isLocal) return Optional.empty();

        Instant now = clock.instant();
        String[] rejected = {null};
        requestsByIp.compute(ip, (k, existing) -> {
            Deque<Instant> history = existing != null ? existing : new ArrayDeque<>();
            Instant dayAgo = now.minus(Duration.ofDays(1));
            while (!history.isEmpty() && history.peekFirst().isBefore(dayAgo)) {
                history.pollFirst();
            }

            if (history.size() >= perDayMax) {
                rejected[0] = ("too many requests today");
                return history.isEmpty() ? null : history;
            }

            Instant minuteAgo = now.minus(Duration.ofMinutes(1));
            long lastMinuteCount = history.stream().filter(t -> !t.isBefore(minuteAgo)).count();
            if (lastMinuteCount >= perMinuteMax) {
                rejected[0] = ("too many requests this minute");
                return history;
            }

            history.addLast(now);
            return history;
        });
        return Optional.ofNullable(rejected[0]);
    }
}
