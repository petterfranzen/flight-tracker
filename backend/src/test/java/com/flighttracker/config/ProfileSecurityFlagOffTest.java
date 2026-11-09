package com.flighttracker.config;

import com.flighttracker.controller.HealthController;
import com.flighttracker.controller.ProfileController;
import com.flighttracker.profile.ProfileProperties;
import com.flighttracker.service.agent.SweepHealthTracker;
import org.junit.jupiter.api.Test;
import org.springframework.boot.SpringBootConfiguration;
import org.springframework.boot.autoconfigure.EnableAutoConfiguration;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.boot.jdbc.autoconfigure.DataSourceAutoConfiguration;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import javax.sql.DataSource;
import java.io.IOException;
import java.net.ServerSocket;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Design section9-hq #84 step 2, the production default: with
 * {@code flighttracker.profile.enabled=false} the app is unchanged for an
 * anonymous visitor — no security redirect, no CSRF 403, no session cookie —
 * and the profile endpoint answers {@code 503} so the SPA can hide the
 * sign-in control instead of showing a broken one (§7).
 *
 * <p>This is the <b>real filter set</b>, not a stub: the app's own
 * {@link SecurityHeadersFilter} and the flag-off {@link ProfileSecurityConfig}
 * chain front the <b>real</b> {@link HealthController} and
 * {@link ProfileController}, and the assertions below are the header and status
 * contract the reviewer asked the off path to keep (section9-hq #234, must-fix
 * items 1 and 3).
 */
@SpringBootTest(
        classes = ProfileSecurityFlagOffTest.MinimalApp.class,
        webEnvironment = SpringBootTest.WebEnvironment.DEFINED_PORT,
        properties = {
                "spring.main.banner-mode=off",
                "flighttracker.profile.enabled=false"
        })
class ProfileSecurityFlagOffTest {

    private static final int PORT = freePort();

    private static int freePort() {
        try (ServerSocket socket = new ServerSocket(0)) {
            return socket.getLocalPort();
        } catch (Exception ex) {
            throw new IllegalStateException("could not reserve a free port", ex);
        }
    }

    @SpringBootConfiguration
    @EnableAutoConfiguration(exclude = DataSourceAutoConfiguration.class)
    @EnableConfigurationProperties(ProfileProperties.class)
    @Import({ProfileSecurityConfig.class, SecurityHeadersFilter.class,
            ProfileController.class, HealthController.class})
    static class MinimalApp {

        /** A throwaway SQLite file: enough for HealthController's SELECT 1, nothing else. */
        @Bean
        DataSource dataSource() throws IOException {
            Path db = Files.createTempFile("flag-off-health-", ".db");
            db.toFile().deleteOnExit();
            return SqliteDataSourceConfig.buildDataSource(db.toString());
        }

        @Bean
        JdbcTemplate jdbcTemplate(DataSource dataSource) {
            return new JdbcTemplate(dataSource);
        }

        @Bean
        SweepHealthTracker sweepHealthTracker() {
            return new SweepHealthTracker();
        }
    }

    @DynamicPropertySource
    static void serverProperties(DynamicPropertyRegistry registry) {
        registry.add("server.port", () -> PORT);
        registry.add("server.address", () -> "127.0.0.1");
    }

    private static HttpResponse<String> send(String method, String path) throws Exception {
        HttpRequest.Builder request = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + PORT + path));
        if ("POST".equals(method)) {
            request.POST(HttpRequest.BodyPublishers.noBody());
        } else {
            request.GET();
        }
        return HttpClient.newHttpClient().send(request.build(), HttpResponse.BodyHandlers.ofString());
    }

    /** The app's own SecurityHeadersFilter set, the thing an anonymous visitor must still get. */
    private static void assertAppHeaders(HttpResponse<?> response) {
        var headers = response.headers();
        assertThat(headers.firstValue("Content-Security-Policy")).hasValueSatisfying(csp -> {
            assertThat(csp).contains("frame-ancestors 'none'", "script-src 'self'",
                    "connect-src 'self' https://tiles.openfreemap.org");
            assertThat(csp).doesNotContain("'unsafe-eval'");
        });
        assertThat(headers.firstValue("X-Content-Type-Options")).contains("nosniff");
        assertThat(headers.firstValue("X-Frame-Options")).contains("DENY");
        assertThat(headers.firstValue("Referrer-Policy")).contains("strict-origin-when-cross-origin");
        assertThat(headers.firstValue("Permissions-Policy")).isPresent();
    }

    @Test
    void theProfileEndpointAnswers503WhenTheFlagIsOff() throws Exception {
        HttpResponse<String> response = send("GET", "/api/profile");
        assertThat(response.statusCode()).isEqualTo(503);
        // Reachable only with the flag off: before this slice the path fell through to the
        // SPA fallback (200 + index.html on a packaged jar, 404 without one). The SPA hides
        // the sign-in control on this 503 — the deliberate change design §7 asks for.
        assertAppHeaders(response);
    }

    @Test
    void aRealTwoHundredCarriesTheAppHeaders() throws Exception {
        HttpResponse<String> response = send("GET", "/api/health");
        assertThat(response.statusCode()).isEqualTo(200);
        assertThat(response.body()).contains("\"status\":\"UP\"");
        assertAppHeaders(response);
    }

    @Test
    void aRealFourOhFourCarriesTheAppHeaders() throws Exception {
        HttpResponse<String> response = send("GET", "/api/does-not-exist");
        assertThat(response.statusCode()).isEqualTo(404);
        assertAppHeaders(response);
    }

    @Test
    void aPostToTheGetOnlyHealthRouteStillKeepsIts405() throws Exception {
        // blackbox-tests/error-bodies.test.js pins this on the real jar; a blanket CSRF config
        // would flip it to 403, so the flag-off chain must not touch it either.
        assertThat(send("POST", "/api/health").statusCode()).isEqualTo(405);
    }

    @Test
    void malformedPathsBehaveAsBeforeTheChain_andStillCarryTheAppHeaders() throws Exception {
        // With the flag off, Spring Security's StrictHttpFirewall used to reject these with a 400
        // that carried none of the app's headers. The off path now uses DefaultHttpFirewall, so
        // Tomcat/MVC answer them exactly as they did before the chain existed (statuses measured
        // against main at 3872e6c) and SecurityHeadersFilter still owns the headers.
        assertMalformedPath("//api/health", 404);
        assertMalformedPath("/api/health;x=1", 200);
        assertMalformedPath("/api/%2e%2e/health", 404);
        assertMalformedPath("/api/health%25", 404);
        assertMalformedPath("/api/../api/health", 404);
    }

    /** Status as it was before the chain, and the app headers the chain must not have eaten. */
    private static void assertMalformedPath(String path, int expectedStatus) throws Exception {
        HttpResponse<String> response = send("GET", path);
        assertThat(response.statusCode()).as("status for %s", path).isEqualTo(expectedStatus);
        assertAppHeaders(response);
    }

    @Test
    void noSessionCookieIsEverSetOnTheOffPath() throws Exception {
        for (String path : new String[] {"/api/health", "/api/profile", "/api/does-not-exist"}) {
            assertThat(send("GET", path).headers().allValues("Set-Cookie"))
                    .as("no cookie on %s with the flag off", path).isEmpty();
        }
    }
}
