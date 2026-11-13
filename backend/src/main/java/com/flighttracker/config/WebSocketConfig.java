package com.flighttracker.config;

import com.flighttracker.service.LiveFeedBroadcaster;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.socket.config.annotation.EnableWebSocket;
import org.springframework.web.socket.config.annotation.WebSocketConfigurer;
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry;

import java.util.Arrays;

/**
 * Registers {@code /ws/live} with an Origin allow-list (finding M2 of
 * docs/agents/reviews/security-headers.md).
 *
 * <p>Spring's handshake interceptor accepts a request whose {@code Origin} is
 * absent (non-browser clients, the blackbox suite), is same-origin with the
 * request's own scheme/host/port, or is in the list below; anything else gets
 * 403. Behind Cloudflare the app sees plain HTTP, so an https page is not
 * "same-origin" to it: the public host must be listed, which is why it is in
 * the default. {@code flighttracker.ws.allowed-origins} is a comma-separated
 * list of full origins (scheme://host[:port]).
 */
@Configuration
@EnableWebSocket
public class WebSocketConfig implements WebSocketConfigurer {

    private final LiveFeedBroadcaster broadcaster;
    private final String[] allowedOrigins;

    public WebSocketConfig(LiveFeedBroadcaster broadcaster,
                           @Value("${flighttracker.ws.allowed-origins}") String allowedOrigins) {
        this.broadcaster = broadcaster;
        this.allowedOrigins = parse(allowedOrigins);
    }

    static String[] parse(String csv) {
        return Arrays.stream(csv.split(","))
                .map(String::trim)
                .filter(s -> !s.isEmpty())
                .filter(s -> !s.equals("*")) // a wildcard would silently undo the allow-list
                .toArray(String[]::new);
    }

    @Override
    public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
        registry.addHandler(broadcaster, "/ws/live").setAllowedOrigins(allowedOrigins);
    }
}
