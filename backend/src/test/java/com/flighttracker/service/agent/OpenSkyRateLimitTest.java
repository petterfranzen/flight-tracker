package com.flighttracker.service.agent;

import org.junit.jupiter.api.Test;
import org.springframework.http.HttpHeaders;

import java.time.Duration;
import java.time.Instant;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Reading OpenSky's own rate-limit headers: what it says is left, when the
 * window resets, and — with no header seen — staying out of the way rather
 * than guessing a budget.
 */
class OpenSkyRateLimitTest {

    private static final Instant NOW = Instant.parse("2026-10-12T12:00:00Z");

    private static HttpHeaders headers(String... nameValue) {
        HttpHeaders h = new HttpHeaders();
        for (int i = 0; i < nameValue.length; i += 2) {
            h.add(nameValue[i], nameValue[i + 1]);
        }
        return h;
    }

    @Test
    void readsRemainingAndResetFromOpenSkysOwnHeaders() {
        OpenSkyRateLimit limit = new OpenSkyRateLimit();

        limit.observe(headers(
                OpenSkyRateLimit.REMAINING_HEADER, "3998",
                OpenSkyRateLimit.RETRY_AFTER_HEADER, "900"), NOW);

        assertThat(limit.known()).isTrue();
        assertThat(limit.remaining()).isEqualTo(3998);
        assertThat(limit.resetAt()).isEqualTo(NOW.plusSeconds(900));
        assertThat(limit.exhausted(NOW)).isFalse();
    }

    @Test
    void zeroRemainingWithTheResetStillAhead_isExhausted() {
        OpenSkyRateLimit limit = new OpenSkyRateLimit();
        limit.observe(headers(OpenSkyRateLimit.REMAINING_HEADER, "0"), NOW);
        limit.observe(headers(OpenSkyRateLimit.RETRY_AFTER_HEADER, "120"), NOW);

        assertThat(limit.exhausted(NOW)).isTrue();
        assertThat(limit.waitUntilReset(NOW)).contains(Duration.ofSeconds(120));
    }

    @Test
    void aResetInThePastIsNotExhausted() {
        OpenSkyRateLimit limit = new OpenSkyRateLimit();
        limit.observe(headers(
                OpenSkyRateLimit.REMAINING_HEADER, "0",
                OpenSkyRateLimit.RETRY_AFTER_HEADER, "10"), NOW);
        Instant afterReset = NOW.plusSeconds(11);

        assertThat(limit.exhausted(afterReset)).isFalse();
        assertThat(limit.waitUntilReset(afterReset)).isEmpty();
    }

    @Test
    void aPositiveRemainingIsNeverExhausted() {
        OpenSkyRateLimit limit = new OpenSkyRateLimit();
        limit.observe(headers(
                OpenSkyRateLimit.REMAINING_HEADER, "1",
                OpenSkyRateLimit.RETRY_AFTER_HEADER, "10"), NOW);

        assertThat(limit.exhausted(NOW)).isFalse();
    }

    @Test
    void noHeaderYet_isUnknownSoNothingIsAssumed() {
        OpenSkyRateLimit limit = new OpenSkyRateLimit();

        // A response without the headers, a 5xx before OpenSky has told us
        // anything, a test fixture: polling must carry on as it always did.
        limit.observe(headers("Server", "envoy"), NOW);
        assertThat(limit.known()).isFalse();
        assertThat(limit.exhausted(NOW)).isFalse();
        assertThat(limit.waitUntilReset(NOW)).isEmpty();

        limit.observe(null, NOW);
        assertThat(limit.known()).isFalse();
    }

    @Test
    void fallsBackToTheStandardRetryAfterHeader() {
        OpenSkyRateLimit limit = new OpenSkyRateLimit();
        limit.observe(headers(
                OpenSkyRateLimit.REMAINING_HEADER, "0",
                OpenSkyRateLimit.RETRY_AFTER_HTTP_HEADER, "60"), NOW);

        assertThat(limit.resetAt()).isEqualTo(NOW.plusSeconds(60));
        assertThat(limit.exhausted(NOW)).isTrue();
    }

    @Test
    void anUnparseableHeaderIsIgnoredNotThrown() {
        OpenSkyRateLimit limit = new OpenSkyRateLimit();
        limit.observe(headers(
                OpenSkyRateLimit.REMAINING_HEADER, "n/a",
                OpenSkyRateLimit.RETRY_AFTER_HEADER, "Wed, 21 Oct 2026 07:28:00 GMT"), NOW);

        assertThat(limit.known()).isFalse(); // an HTTP-date Retry-After tells us nothing numeric
        assertThat(limit.exhausted(NOW)).isFalse();
    }

    @Test
    void aLaterResponseOverwritesTheEarlierOne() {
        OpenSkyRateLimit limit = new OpenSkyRateLimit();
        limit.observe(headers(OpenSkyRateLimit.REMAINING_HEADER, "0"), NOW);
        limit.observe(headers(OpenSkyRateLimit.REMAINING_HEADER, "42"), NOW.plusSeconds(1));

        assertThat(limit.remaining()).isEqualTo(42);
        assertThat(limit.exhausted(NOW.plusSeconds(2))).isFalse();
    }
}
