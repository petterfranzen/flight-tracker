package com.flighttracker.service.agent;

import org.springframework.http.HttpHeaders;

import java.time.Duration;
import java.time.Instant;
import java.util.Optional;

/**
 * OpenSky's own rate-limit signal, read off every response instead of
 * guessed at. OpenSky sends {@code X-Rate-Limit-Remaining} (credits left in
 * the account's daily budget) and {@code X-Rate-Limit-Retry-After-Seconds}
 * (how long until that budget resets) on its {@code /states/all} answers —
 * success and error alike. Before this, {@link OpenSkyAgent} only ever read
 * {@code Retry-After} off a 429, fell back to its own capped backoff
 * otherwise, and kept knocking; the docs' named header went unread.
 *
 * <p>Credits are per account, not per IP once a bearer token is in play, and
 * a full-world sweep costs more than a bbox one — so "how much is left" is
 * the honest place to decide whether the next call is worth making.
 *
 * <p>Not thread-safe by design, like {@link PollBackoff}: the orchestrator's
 * scheduled poll loop runs on one thread.
 */
public class OpenSkyRateLimit {

    /** Credits left in the current window, as OpenSky reports them. */
    static final String REMAINING_HEADER = "X-Rate-Limit-Remaining";
    /** Seconds until the window resets, as OpenSky reports them. */
    static final String RETRY_AFTER_HEADER = "X-Rate-Limit-Retry-After-Seconds";
    /** The standard header OpenSky may send instead (typically on a 429). */
    static final String RETRY_AFTER_HTTP_HEADER = "Retry-After";

    /** -1 until a response actually tells us; not every answer carries the headers. */
    private volatile long remaining = -1;
    private volatile Instant resetAt = Instant.EPOCH;

    /** Reads whatever rate-limit headers this response carries; leaves the last known values alone when it carries none. */
    public void observe(HttpHeaders headers, Instant now) {
        if (headers == null) return;
        Long left = longHeader(headers, REMAINING_HEADER);
        if (left != null) remaining = left;
        Long retryAfter = longHeader(headers, RETRY_AFTER_HEADER);
        if (retryAfter == null) retryAfter = longHeader(headers, RETRY_AFTER_HTTP_HEADER);
        if (retryAfter != null) resetAt = now.plusSeconds(retryAfter);
    }

    /** False until a response has carried {@link #REMAINING_HEADER} — the cue to keep polling as before rather than guess. */
    public boolean known() {
        return remaining >= 0;
    }

    public long remaining() {
        return remaining;
    }

    public Instant resetAt() {
        return resetAt;
    }

    /** True while the budget is spent and the reset it advertised is still in the future. */
    public boolean exhausted(Instant now) {
        return remaining == 0 && now.isBefore(resetAt);
    }

    /** How long until the advertised reset, present only while that reset is still ahead of {@code now}. */
    public Optional<Duration> waitUntilReset(Instant now) {
        return now.isBefore(resetAt) ? Optional.of(Duration.between(now, resetAt)) : Optional.empty();
    }

    /** Parses one header, treating anything unparseable as absent rather than throwing mid-poll. */
    static Long longHeader(HttpHeaders headers, String name) {
        if (headers == null) return null;
        String value = headers.getFirst(name);
        if (value == null) return null;
        try {
            return Long.parseLong(value.trim());
        } catch (NumberFormatException e) {
            return null;
        }
    }
}
