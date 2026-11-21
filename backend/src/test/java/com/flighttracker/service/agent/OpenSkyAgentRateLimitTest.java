package com.flighttracker.service.agent;

import com.flighttracker.dto.Bounds;
import com.flighttracker.observability.PhaseLogger;
import com.flighttracker.service.ViewportService;
import com.flighttracker.service.enrichment.OpenSkyOAuthTokenProvider;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.test.web.client.MockRestServiceServer;
import org.springframework.test.web.client.ResponseCreator;
import org.springframework.test.web.client.response.DefaultResponseCreator;
import org.springframework.web.client.RestClient;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.client.ExpectedCount.once;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.requestTo;
import static org.springframework.test.web.client.response.MockRestResponseCreators.withStatus;
import static org.springframework.test.web.client.response.MockRestResponseCreators.withSuccess;

/**
 * The agent's side of honest freshness: OpenSky's own rate-limit headers are
 * read and respected, and the hot poll and the global sweep back off
 * independently — a 429 on the frequent poll must not silently silence the
 * always-on sweep (the shared-backoff bug this replaces).
 */
class OpenSkyAgentRateLimitTest {

    private static final String BASE = "https://opensky-network.org/api";
    private static final String STATES = BASE + "/states/all";
    private static final String HOT = STATES + "?lamin=55.0&lamax=69.0&lomin=10.0&lomax=25.0";
    private static final Instant NOW = Instant.parse("2026-10-12T12:00:00Z");
    private static final Bounds VIEW = new Bounds(55, 69, 10, 25);
    private static final long SWEEP_INTERVAL_SECONDS = 360;

    private MockRestServiceServer server;
    private RestClient.Builder builder;

    @BeforeEach
    void setUp() {
        builder = RestClient.builder();
        server = MockRestServiceServer.bindTo(builder).build();
    }

    private OpenSkyAgent agent() {
        ViewportService viewport = mock(ViewportService.class);
        when(viewport.current()).thenReturn(VIEW);
        OpenSkyOAuthTokenProvider tokens = mock(OpenSkyOAuthTokenProvider.class);
        when(tokens.getAccessToken()).thenReturn(Optional.empty());
        return new OpenSkyAgent(true, BASE, viewport, tokens, new PhaseLogger(),
                Clock.fixed(NOW, ZoneOffset.UTC), SWEEP_INTERVAL_SECONDS, builder);
    }

    private static String body() {
        return "{\"time\":1791230400,\"states\":[[\"abc123\",\"SAS1\",1791230400,1791230400,1791230400,18.0,59.0,10000.0,false,200.0,90.0,0.0]]}";
    }

    /** Expects exactly one request to {@code url}, answered with {@code response}. */
    private void expect(String url, ResponseCreator response) {
        server.expect(once(), requestTo(url)).andRespond(response);
    }

    /** One aircraft, with the given rate-limit header name/value pairs. */
    private static DefaultResponseCreator ok(String... headerNamesAndValues) {
        DefaultResponseCreator response = withSuccess(body(), MediaType.APPLICATION_JSON);
        for (int i = 0; i < headerNamesAndValues.length; i += 2) {
            response = response.header(headerNamesAndValues[i], headerNamesAndValues[i + 1]);
        }
        return response;
    }

    /** One aircraft, with the credits left and the seconds until the budget resets. */
    private static DefaultResponseCreator okWithBudget(String remaining, String retryAfterSeconds) {
        return ok(OpenSkyRateLimit.REMAINING_HEADER, remaining, OpenSkyRateLimit.RETRY_AFTER_HEADER, retryAfterSeconds);
    }

    private static DefaultResponseCreator throttled() {
        return withStatus(HttpStatus.TOO_MANY_REQUESTS).header("Retry-After", "30");
    }

    @Test
    void aSpentBudgetInTheHeaders_skipsTheNextCall() {
        expect(STATES, okWithBudget("0", "120"));

        OpenSkyAgent agent = agent();
        assertThat(agent.pollGlobal()).hasSize(1);
        assertThat(agent.pollGlobal()).isEmpty(); // budget spent — the next call is not made at all
        server.verify();                          // exactly the one expected request
    }

    @Test
    void creditsLeftInTheHeader_keepTheSweepGoing() {
        expect(STATES, okWithBudget("4000", "3600"));
        expect(STATES, ok(OpenSkyRateLimit.REMAINING_HEADER, "3996"));

        OpenSkyAgent agent = agent();
        assertThat(agent.pollGlobal()).hasSize(1);
        assertThat(agent.pollGlobal()).hasSize(1);
        server.verify();
    }

    @Test
    void aHotPollThrottle_doesNotSilenceTheGlobalSweep() {
        expect(HOT, throttled());
        expect(STATES, ok());

        OpenSkyAgent agent = agent();
        assertThat(agent.poll()).isEmpty();        // 429 on the hot poll
        assertThat(agent.pollGlobal()).hasSize(1); // the sweep still runs on its own backoff
        server.verify();
    }

    @Test
    void aSweepThrottle_doesNotSilenceTheHotPoll() {
        expect(STATES, throttled());
        expect(HOT, ok());

        OpenSkyAgent agent = agent();
        assertThat(agent.pollGlobal()).isEmpty();  // 429 on the sweep
        assertThat(agent.poll()).hasSize(1);       // the hot poll still runs on its own backoff
        server.verify();
    }

    @Test
    void hotPollYields_whileTheCreditsLeftAreReservedForSweeps() {
        expect(STATES, okWithBudget("40", "43200"));

        OpenSkyAgent agent = agent();
        assertThat(agent.pollGlobal()).hasSize(1);

        // Noon UTC, 360s sweeps: ~120 sweeps left * 4 credits = 480 needed, only
        // 40 left — so the viewport poll yields and makes no request this cycle.
        assertThat(agent.poll()).isEmpty();
        server.verify();
    }

    @Test
    void hotPollRuns_whenTheCreditsLeftCoverTheRemainingSweeps() {
        expect(STATES, okWithBudget("4000", "43200"));
        expect(HOT, ok());

        OpenSkyAgent agent = agent();
        assertThat(agent.pollGlobal()).hasSize(1);
        assertThat(agent.poll()).hasSize(1);
        server.verify();
    }

    @Test
    void sweepsDueToday_countsTheIntervalsLeftBeforeTheBudgetResets() {
        assertThat(OpenSkyAgent.sweepsDueToday(Instant.parse("2026-10-12T12:00:00Z"), 360)).isEqualTo(120);
        assertThat(OpenSkyAgent.sweepsDueToday(Instant.parse("2026-10-12T23:59:00Z"), 360)).isEqualTo(1);
        assertThat(OpenSkyAgent.sweepsDueToday(Instant.parse("2026-10-12T12:00:00Z"), 0)).isZero();
    }
}
