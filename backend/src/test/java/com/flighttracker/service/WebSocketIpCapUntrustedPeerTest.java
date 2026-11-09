package com.flighttracker.service;

import com.flighttracker.config.WebSocketConfig;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
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
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

/**
 * With no trusted proxy configured the socket peer is the only identity:
 * spoofed CF-Connecting-IP / X-Forwarded-For on the upgrade request must not
 * buy extra connections (review #143 M3 + M4).
 */
@SpringBootTest(
        classes = WebSocketIpCapUntrustedPeerTest.App.class,
        webEnvironment = SpringBootTest.WebEnvironment.DEFINED_PORT,
        properties = {"spring.main.banner-mode=off", "flighttracker.ws.max-connections-per-ip=3",
                "flighttracker.proxy.trusted-proxies="})
class WebSocketIpCapUntrustedPeerTest {

    static final int PORT = WebSocketIpCapTest.freePort();

    @SpringBootConfiguration
    @EnableAutoConfiguration(exclude = DataSourceAutoConfiguration.class)
    @Import({WebSocketConfig.class, LiveFeedBroadcaster.class, ViewportService.class, ClientIpResolver.class})
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

    private static WebSocketIpCapTest.Client open(int i) throws Exception {
        List<Integer> closes = new CopyOnWriteArrayList<>();
        WebSocket ws = HttpClient.newHttpClient().newWebSocketBuilder()
                .header("CF-Connecting-IP", "203.0.113." + i)
                .header("X-Forwarded-For", "198.51.100." + i)
                .buildAsync(URI.create("ws://127.0.0.1:" + PORT + "/ws/live"), new WebSocket.Listener() {
                    @Override
                    public CompletionStage<?> onClose(WebSocket webSocket, int statusCode, String reason) {
                        closes.add(statusCode);
                        return null;
                    }
                }).get(10, TimeUnit.SECONDS);
        return new WebSocketIpCapTest.Client(ws, closes);
    }

    @Test
    void rotatingSpoofedHeadersDoNotEvadeTheCap() throws Exception {
        List<WebSocketIpCapTest.Client> all = new ArrayList<>();
        for (int i = 0; i < 6; i++) all.add(open(i));

        await().atMost(10, TimeUnit.SECONDS).untilAsserted(() -> {
            long refused = all.stream().filter(c -> c.closeCodes().contains(1013)).count();
            assertThat(refused).isEqualTo(3);
        });
        assertThat(broadcaster.connectionsFor("127.0.0.1")).isEqualTo(3);
        assertThat(broadcaster.connectionsFor("203.0.113.0")).isZero();
        all.forEach(c -> c.ws().abort());
        await().atMost(10, TimeUnit.SECONDS).untilAsserted(
                () -> assertThat(broadcaster.connectionsFor("127.0.0.1")).isZero());
    }
}
