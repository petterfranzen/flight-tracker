package com.flighttracker.service;

import com.flighttracker.config.WebSocketConfig;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import com.flighttracker.config.ProfileSecurityConfig;
import org.springframework.boot.SpringBootConfiguration;
import org.springframework.boot.autoconfigure.EnableAutoConfiguration;
import org.springframework.boot.jdbc.autoconfigure.DataSourceAutoConfiguration;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

import java.net.ServerSocket;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.WebSocket;
import java.net.http.WebSocketHandshakeException;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

/**
 * Per-IP /ws/live cap (review #143 M3) through a real Tomcat and real
 * handshakes. The test client connects from loopback, which is the default
 * trusted proxy (the cloudflared tunnel), so CF-Connecting-IP names the
 * visitor. WebSocketIpCapUntrustedPeerTest covers a peer that is not trusted.
 */
@SpringBootTest(
        classes = WebSocketIpCapTest.App.class,
        webEnvironment = SpringBootTest.WebEnvironment.DEFINED_PORT,
        properties = {"spring.main.banner-mode=off", "flighttracker.ws.max-connections-per-ip=3"})
class WebSocketIpCapTest {

    static final int PORT = freePort();

    static int freePort() {
        try (ServerSocket socket = new ServerSocket(0)) {
            return socket.getLocalPort();
        } catch (Exception ex) {
            throw new IllegalStateException("could not reserve a free port", ex);
        }
    }

    @SpringBootConfiguration
    @EnableAutoConfiguration(exclude = DataSourceAutoConfiguration.class)
    @Import({WebSocketConfig.class, LiveFeedBroadcaster.class, ViewportService.class, ClientIpResolver.class,
            ProfileSecurityConfig.class})
    static class App {
        @Bean
        ObjectMapper objectMapper() {
            return new JsonMapper();
        }
    }

    @DynamicPropertySource
    static void serverProperties(DynamicPropertyRegistry registry) {
        registry.add("server.port", () -> PORT);
        registry.add("server.address", () -> "127.0.0.1");
    }

    @Autowired
    LiveFeedBroadcaster broadcaster;

    /** One client socket and the close code the server sent it, if any. */
    record Client(WebSocket ws, List<Integer> closeCodes) { }

    static Client open(String cfIp) throws Exception {
        List<Integer> closes = new CopyOnWriteArrayList<>();
        WebSocket.Builder builder = HttpClient.newHttpClient().newWebSocketBuilder();
        if (cfIp != null) builder.header("CF-Connecting-IP", cfIp);
        WebSocket ws = builder.buildAsync(URI.create("ws://127.0.0.1:" + PORT + "/ws/live"),
                new WebSocket.Listener() {
                    @Override
                    public CompletionStage<?> onClose(WebSocket webSocket, int statusCode, String reason) {
                        closes.add(statusCode);
                        return null;
                    }
                }).get(10, TimeUnit.SECONDS);
        return new Client(ws, closes);
    }

    private void awaitCount(String ip, int expected) {
        await().atMost(10, TimeUnit.SECONDS).untilAsserted(
                () -> assertThat(broadcaster.connectionsFor(ip)).isEqualTo(expected));
    }

    @Test
    void connectionOverTheCapIsClosed1013_othersStayUp_andAClosedOneFreesASlot() throws Exception {
        String ip = "203.0.113.50";
        List<Client> held = new ArrayList<>();
        for (int i = 0; i < 3; i++) held.add(open(ip));
        awaitCount(ip, 3);

        Client extra = open(ip); // the upgrade succeeds, then the server turns it away
        await().atMost(10, TimeUnit.SECONDS).untilAsserted(
                () -> assertThat(extra.closeCodes()).containsExactly(1013));
        for (Client c : held) {
            assertThat(c.ws().isInputClosed()).isFalse();
            assertThat(c.closeCodes()).isEmpty();
        }
        assertThat(broadcaster.connectionsFor(ip)).isEqualTo(3);

        // another visitor behind the same tunnel is unaffected
        Client other = open("203.0.113.51");
        awaitCount("203.0.113.51", 1);
        assertThat(other.closeCodes()).isEmpty();

        // a closed connection frees a slot
        held.get(0).ws().sendClose(WebSocket.NORMAL_CLOSURE, "bye").get(5, TimeUnit.SECONDS);
        awaitCount(ip, 2);
        Client again = open(ip);
        awaitCount(ip, 3);
        assertThat(again.closeCodes()).isEmpty();

        for (Client c : held.subList(1, 3)) c.ws().abort();
        again.ws().abort();
        other.ws().abort();
        awaitCount(ip, 0);
        awaitCount("203.0.113.51", 0);
    }

    @Test
    void manyDroppedConnectionsDoNotLockTheVisitorOut() throws Exception {
        String ip = "203.0.113.60";
        // abort() drops the TCP connection with no close handshake: the
        // transport-error / abrupt-close path. More drops than the cap.
        for (int i = 0; i < 12; i++) {
            Client c = open(ip);
            assertThat(c.closeCodes()).isEmpty();
            c.ws().abort();
            awaitCount(ip, 0);
        }
        Client fresh = open(ip);
        awaitCount(ip, 1);
        assertThat(fresh.closeCodes()).isEmpty();
        fresh.ws().abort();
        awaitCount(ip, 0);
    }

    @Test
    void rotatingTheHeaderFromATrustedProxyIsHowVisitorsAreTold_apart() throws Exception {
        List<Client> clients = new ArrayList<>();
        for (int i = 0; i < 6; i++) clients.add(open("198.51.100." + i)); // 6 visitors, 1 socket each: all fine
        for (Client c : clients) {
            assertThat(c.closeCodes()).isEmpty();
        }
        clients.forEach(c -> c.ws().abort());
    }

    @Test
    void trustedProxyWithoutHeadersSharesOneCapUnderThePeerKey() throws Exception {
        List<Client> held = new ArrayList<>();
        for (int i = 0; i < 3; i++) held.add(open(null)); // loopback is trusted but names no visitor
        awaitCount("127.0.0.1", 3);
        Client extra = open(null);
        await().atMost(10, TimeUnit.SECONDS).untilAsserted(
                () -> assertThat(extra.closeCodes()).containsExactly(1013));
        assertThat(broadcaster.connectionsFor("127.0.0.1")).isEqualTo(3);
        // a visitor the proxy does name is not caught by that shared cap
        Client named = open("203.0.113.77");
        awaitCount("203.0.113.77", 1);
        assertThat(named.closeCodes()).isEmpty();

        held.forEach(c -> c.ws().abort());
        named.ws().abort();
        awaitCount("127.0.0.1", 0);
        awaitCount("203.0.113.77", 0);
    }

    @Test
    void originRejectedHandshakeNeverTakesASlot() throws Exception {
        String visitor = "203.0.113.90";
        for (int i = 0; i < 10; i++) { // more attempts than the cap of 3
            WebSocket.Builder builder = HttpClient.newHttpClient().newWebSocketBuilder()
                    .header("Origin", "https://evil.example")
                    .header("CF-Connecting-IP", visitor);
            Throwable failure = null;
            try {
                builder.buildAsync(URI.create("ws://127.0.0.1:" + PORT + "/ws/live"),
                        new WebSocket.Listener() { }).get(10, TimeUnit.SECONDS);
            } catch (Exception ex) {
                failure = ex.getCause();
            }
            assertThat(failure).isInstanceOf(WebSocketHandshakeException.class);
            assertThat(((WebSocketHandshakeException) failure).getResponse().statusCode()).isEqualTo(403);
        }
        assertThat(broadcaster.connectionsFor(visitor)).isZero();
        assertThat(broadcaster.connectionsFor("127.0.0.1")).isZero();
        assertThat(broadcaster.trackedIps()).isZero();
        assertThat(broadcaster.openSessions()).isZero();

        // and the visitor still gets its full allowance afterwards
        List<Client> held = new ArrayList<>();
        for (int i = 0; i < 3; i++) held.add(open(visitor));
        awaitCount(visitor, 3);
        for (Client c : held) assertThat(c.closeCodes()).isEmpty();
        held.forEach(c -> c.ws().abort());
        awaitCount(visitor, 0);
    }
}
