package com.flighttracker.service.enrichment;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.lang.reflect.Field;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.Callable;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.stream.IntStream;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Pins the OpenSky client-credentials token cache: one token request per
 * expiry window however many callers ask, expiry at
 * max(30 s, expires_in - 60 s), no stale token after a failed refresh, and
 * neither the token nor the client secret in any log line or toString.
 *
 * The provider reads Instant.now() directly (no Clock), so expiry is checked
 * by bracketing the call between two instants and by moving its private
 * expiresAt field — never by sleeping.
 */
class OpenSkyOAuthTokenProviderTest {

    private static final String CLIENT_ID = "test-client";
    private static final String CLIENT_SECRET = "test-secret-do-not-log";
    private static final String TOKEN = "token-abc-do-not-log";

    private StubHttpServer tokenEndpoint;
    private OpenSkyOAuthTokenProvider provider;
    private Logger logger;
    private ListAppender<ILoggingEvent> logs;

    @BeforeEach
    void setUp() throws IOException {
        tokenEndpoint = new StubHttpServer();
        provider = providerWith(CLIENT_ID, CLIENT_SECRET);
        logger = (Logger) LoggerFactory.getLogger(OpenSkyOAuthTokenProvider.class);
        logs = new ListAppender<>();
        logs.start();
        logger.addAppender(logs);
        logger.setLevel(Level.DEBUG);
    }

    @AfterEach
    void tearDown() {
        logger.detachAppender(logs);
        logger.setLevel(null);
        tokenEndpoint.close();
    }

    private OpenSkyOAuthTokenProvider providerWith(String clientId, String clientSecret) {
        return new OpenSkyOAuthTokenProvider(tokenEndpoint.baseUrl() + "/token", clientId, clientSecret);
    }

    private static String tokenJson(String token, String expiresIn) {
        return "{\"access_token\":\"" + token + "\",\"expires_in\":" + expiresIn + ",\"token_type\":\"Bearer\"}";
    }

    private void issueTokens(String expiresIn) {
        AtomicInteger issued = new AtomicInteger();
        tokenEndpoint.handle(request -> new StubHttpServer.Reply(200,
                tokenJson(TOKEN + "-" + issued.incrementAndGet(), expiresIn)));
    }

    private static Field expiresAtField() throws NoSuchFieldException {
        Field field = OpenSkyOAuthTokenProvider.class.getDeclaredField("expiresAt");
        field.setAccessible(true);
        return field;
    }

    private Instant expiresAt() throws ReflectiveOperationException {
        return (Instant) expiresAtField().get(provider);
    }

    private void expireCachedToken() throws ReflectiveOperationException {
        expiresAtField().set(provider, Instant.now().minusSeconds(1));
    }

    @ParameterizedTest(name = "client-id ''{0}'', secret ''{1}''")
    @CsvSource(value = {"'', secret", "client, ''", "'  ', secret", "client, '  '", "NULL, secret", "client, NULL"},
            nullValues = "NULL")
    void missingCredentials_returnEmptyWithoutCallingTheEndpoint(String clientId, String clientSecret) {
        issueTokens("1800");

        assertThat(providerWith(clientId, clientSecret).getAccessToken()).isEmpty();
        assertThat(tokenEndpoint.requests()).isEmpty();
    }

    @Test
    void tokenRequest_postsTheClientCredentialsForm() {
        issueTokens("1800");

        assertThat(provider.getAccessToken()).contains(TOKEN + "-1");

        StubHttpServer.Recorded request = tokenEndpoint.requests().get(0);
        assertThat(request.method() + " " + request.path()).isEqualTo("POST /token");
        assertThat(request.contentType()).startsWith("application/x-www-form-urlencoded");
        assertThat(URLDecoder.decode(request.body(), StandardCharsets.UTF_8).split("&")).containsExactly(
                "grant_type=client_credentials", "client_id=" + CLIENT_ID, "client_secret=" + CLIENT_SECRET);
    }

    @Test
    void cachedToken_isReusedUntilItExpires() {
        issueTokens("1800");

        assertThat(provider.getAccessToken()).contains(TOKEN + "-1");
        assertThat(provider.getAccessToken()).contains(TOKEN + "-1");
        assertThat(tokenEndpoint.requests()).hasSize(1);
    }

    @Test
    void expiredToken_isRefreshedWithOneNewRequest() throws ReflectiveOperationException {
        issueTokens("1800");
        provider.getAccessToken();

        expireCachedToken();

        assertThat(provider.getAccessToken()).contains(TOKEN + "-2");
        assertThat(tokenEndpoint.requests()).hasSize(2);
    }

    @ParameterizedTest(name = "expires_in {0} -> cached {1} s")
    @CsvSource({"1800, 1740", "3600, 3540", "91, 31", "90, 30", "60, 30", "0, 30", "-5, 30", "null, 30"})
    void expiry_isExpiresInMinusSixtySeconds_butNeverUnderThirty(String expiresIn, long cachedSeconds)
            throws ReflectiveOperationException {
        issueTokens(expiresIn);

        Instant before = Instant.now();
        provider.getAccessToken();
        Instant after = Instant.now();

        assertThat(expiresAt()).isBetween(before.plusSeconds(cachedSeconds), after.plusSeconds(cachedSeconds));
    }

    @Test
    void concurrentCallers_shareOneTokenRequest() throws Exception {
        issueTokens("1800");
        int callers = 8;
        CountDownLatch start = new CountDownLatch(1);
        Callable<Optional<String>> caller = () -> {
            start.await();
            return provider.getAccessToken();
        };
        ExecutorService pool = Executors.newFixedThreadPool(callers);
        try {
            List<Future<Optional<String>>> results = IntStream.range(0, callers)
                    .mapToObj(i -> pool.submit(caller)).toList();
            start.countDown();
            for (Future<Optional<String>> result : results) {
                assertThat(result.get()).contains(TOKEN + "-1");
            }
        } finally {
            pool.shutdownNow();
        }
        assertThat(tokenEndpoint.requests()).hasSize(1);
    }

    @ParameterizedTest(name = "HTTP {0}")
    @CsvSource({"400", "401", "500"})
    void endpointError_returnsEmptyAndLogsAWarning(int status) {
        tokenEndpoint.reply(status, "{\"error\":\"invalid_client\"}");

        assertThat(provider.getAccessToken()).isEmpty();
        assertThat(logs.list).singleElement().satisfies(event -> {
            assertThat(event.getLevel()).isEqualTo(Level.WARN);
            assertThat(event.getFormattedMessage()).startsWith("Failed to obtain OpenSky OAuth token");
        });
    }

    @ParameterizedTest(name = "{0}")
    @CsvSource(delimiter = '|', value = {"{\"expires_in\":1800}", "{\"access_token\":null}", "{}"})
    void responseWithoutAccessToken_returnsEmptyAndLogsAWarning(String json) {
        tokenEndpoint.reply(200, json);

        assertThat(provider.getAccessToken()).isEmpty();
        assertThat(logs.list).singleElement().satisfies(event -> {
            assertThat(event.getLevel()).isEqualTo(Level.WARN);
            assertThat(event.getFormattedMessage()).isEqualTo("OpenSky token response had no access_token");
        });
    }

    @Test
    void unreachableEndpoint_returnsEmpty() throws IOException {
        OpenSkyOAuthTokenProvider unreachable =
                new OpenSkyOAuthTokenProvider(StubHttpServer.unusedBaseUrl() + "/token", CLIENT_ID, CLIENT_SECRET);

        assertThat(unreachable.getAccessToken()).isEmpty();
    }

    @Test
    void failedRefresh_doesNotFallBackToTheExpiredToken() throws ReflectiveOperationException {
        issueTokens("1800");
        provider.getAccessToken();
        expireCachedToken();
        tokenEndpoint.reply(503, "{}");

        assertThat(provider.getAccessToken()).isEmpty();
    }

    @Test
    void failure_isNotCached_soTheNextCallRetries() {
        tokenEndpoint.reply(500, "{}");
        provider.getAccessToken();
        issueTokens("1800");

        assertThat(provider.getAccessToken()).contains(TOKEN + "-1");
        assertThat(tokenEndpoint.requests()).hasSize(2);
    }

    @Test
    void tokenAndSecret_neverAppearInLogsOrToString() throws ReflectiveOperationException {
        issueTokens("1800");
        provider.getAccessToken();
        expireCachedToken();
        tokenEndpoint.reply(500, "{}");
        provider.getAccessToken();

        assertThat(logs.list).isNotEmpty().allSatisfy(event -> assertThat(event.getFormattedMessage())
                .doesNotContain(TOKEN).doesNotContain(CLIENT_SECRET));
        assertThat(provider.toString()).doesNotContain(TOKEN).doesNotContain(CLIENT_SECRET);
    }
}
