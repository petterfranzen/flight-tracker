package com.flighttracker.service;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

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
    // to the last 24h on every check for that IP, which also bounds each
    // IP's own memory use over time; the outer map's key set (distinct
    // IPs ever seen) isn't itself pruned — acceptable at this app's scale
    // (a personal/small-deployment project, not a high-traffic public
    // service), but worth revisiting with a scheduled sweep if that
    // changes.
    private final ConcurrentHashMap<String, Deque<Instant>> requestsByIp = new ConcurrentHashMap<>();

    public RestartRateLimiter(@Value("${flighttracker.rate-limit.restart-per-ip-per-minute}") int perMinuteMax,
                               @Value("${flighttracker.rate-limit.restart-per-ip-per-day}") int perDayMax) {
        this.perMinuteMax = perMinuteMax;
        this.perDayMax = perDayMax;
    }

    /**
     * @param isLocal see ClientIpResolver.isLocal — local callers are exempt entirely.
     * @return empty if allowed (the attempt is recorded); otherwise a short reason it was rejected.
     */
    public Optional<String> checkAndRecord(String ip, boolean isLocal) {
        if (isLocal) return Optional.empty();

        Instant now = Instant.now();
        Deque<Instant> history = requestsByIp.computeIfAbsent(ip, k -> new ArrayDeque<>());
        synchronized (history) {
            Instant dayAgo = now.minus(Duration.ofDays(1));
            while (!history.isEmpty() && history.peekFirst().isBefore(dayAgo)) {
                history.pollFirst();
            }

            if (history.size() >= perDayMax) {
                return Optional.of("too many requests today");
            }

            Instant minuteAgo = now.minus(Duration.ofMinutes(1));
            long lastMinuteCount = history.stream().filter(t -> !t.isBefore(minuteAgo)).count();
            if (lastMinuteCount >= perMinuteMax) {
                return Optional.of("too many requests this minute");
            }

            history.addLast(now);
        }
        return Optional.empty();
    }
}
