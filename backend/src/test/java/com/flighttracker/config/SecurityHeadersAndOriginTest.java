package com.flighttracker.config;

import com.flighttracker.service.LiveFeedBroadcaster;
import org.junit.jupiter.api.Test;
import org.springframework.boot.SpringBootConfiguration;
import org.springframework.boot.autoconfigure.EnableAutoConfiguration;
import org.springframework.boot.jdbc.autoconfigure.DataSourceAutoConfiguration;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.mock.web.MockFilterChain;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

import java.net.ServerSocket;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.WebSocket;
import java.net.http.WebSocketHandshakeException;
import java.util.concurrent.CompletionException;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;

/**
 * Security headers (#163 fix A) and the /ws/live Origin allow-list (fix B),
 * through a real Tomcat on a free port with real handshakes.
 */
@SpringBootTest(
        classes = SecurityHeadersAndOriginTest.MinimalApp.class,
        webEnvironment = SpringBootTest.WebEnvironment.DEFINED_PORT,
        properties = {
                "spring.main.banner-mode=off",
                "flighttracker.ws.allowed-origins=https://flight.example, http://localhost:5173 , ,*"
        })
class SecurityHeadersAndOriginTest {

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
    @Import({WebSocketConfig.class, SecurityHeadersFilter.class})
    static class MinimalApp {
        @Bean
        LiveFeedBroadcaster broadcaster() {
            return mock(LiveFeedBroadcaster.class);
        }
    }

    @DynamicPropertySource
    static void serverProperties(DynamicPropertyRegistry registry) {
        registry.add("server.port", () -> PORT);
        registry.add("server.address", () -> "127.0.0.1");
    }

    /** Handshake status: 101 when opened, otherwise the HTTP status of the rejection. */
    private static int handshake(String origin) throws Exception {
        WebSocket.Builder builder = HttpClient.newHttpClient().newWebSocketBuilder();
        if (origin != null) {
            builder.header("Origin", origin);
        }
        try {
            WebSocket ws = builder.buildAsync(URI.create("ws://127.0.0.1:" + PORT + "/ws/live"),
                    new WebSocket.Listener() { }).get(10, TimeUnit.SECONDS);
            ws.sendClose(WebSocket.NORMAL_CLOSURE, "").get(5, TimeUnit.SECONDS);
            return 101;
        } catch (Exception ex) {
            Throwable cause = ex.getCause() instanceof CompletionException ce && ce.getCause() != null
                    ? ce.getCause() : ex.getCause();
            if (cause instanceof WebSocketHandshakeException h) {
                return h.getResponse().statusCode();
            }
            throw ex;
        }
    }

    @Test
    void listedOriginsAreAccepted() throws Exception {
        assertThat(handshake("https://flight.example")).isEqualTo(101);
        assertThat(handshake("http://localhost:5173")).isEqualTo(101);
    }

    @Test
    void sameOriginIsAccepted() throws Exception {
        assertThat(handshake("http://127.0.0.1:" + PORT)).isEqualTo(101);
    }

    @Test
    void missingOriginIsAcceptedForNonBrowserClients() throws Exception {
        assertThat(handshake(null)).isEqualTo(101);
    }

    @Test
    void otherOriginsAreRejectedWith403() throws Exception {
        assertThat(handshake("https://evil.example")).isEqualTo(403);
        assertThat(handshake("null")).isEqualTo(403);
        // different port on the same host is a different origin
        assertThat(handshake("http://127.0.0.1:" + (PORT + 1))).isEqualTo(403);
        // prefix/suffix tricks on a listed host
        assertThat(handshake("https://flight.example.evil.example")).isEqualTo(403);
        assertThat(handshake("http://flight.example")).isEqualTo(403);
    }

    @Test
    void wildcardInTheListIsIgnored() {
        assertThat(WebSocketConfig.parse("https://a.example, *,,http://b.example"))
                .containsExactly("https://a.example", "http://b.example");
    }

    @Test
    void responsesCarrySecurityHeaders() throws Exception {
        HttpResponse<Void> response = HttpClient.newHttpClient().send(
                HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + PORT + "/anything")).GET().build(),
                HttpResponse.BodyHandlers.discarding());
        var h = response.headers();
        assertThat(h.firstValue("X-Content-Type-Options")).contains("nosniff");
        assertThat(h.firstValue("Referrer-Policy")).contains("strict-origin-when-cross-origin");
        assertThat(h.firstValue("X-Frame-Options")).contains("DENY");
        assertThat(h.firstValue("Permissions-Policy")).isPresent();
        assertThat(h.firstValue("Content-Security-Policy")).hasValueSatisfying(csp -> {
            assertThat(csp).contains("frame-ancestors 'none'", "script-src 'self'",
                    "connect-src 'self' https://tiles.openfreemap.org", "worker-src 'self' blob:");
            assertThat(csp).doesNotContain("script-src 'self' 'unsafe-inline'", "'unsafe-eval'");
        });
        assertThat(h.firstValue("Content-Security-Policy-Report-Only")).isEmpty();
        assertThat(h.firstValue("Strict-Transport-Security")).isEmpty();
    }

    @Test
    void reportOnlySwitchMovesTheCspHeader() throws Exception {
        MockHttpServletResponse response = new MockHttpServletResponse();
        new SecurityHeadersFilter(true).doFilter(new MockHttpServletRequest("GET", "/"), response,
                new MockFilterChain());
        assertThat(response.getHeader("Content-Security-Policy")).isNull();
        assertThat(response.getHeader("Content-Security-Policy-Report-Only")).isEqualTo(SecurityHeadersFilter.CSP);
        assertThat(response.getHeader("X-Frame-Options")).isEqualTo("DENY");
    }

}
