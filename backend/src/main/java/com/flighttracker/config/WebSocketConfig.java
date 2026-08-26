package com.flighttracker.config;

import com.flighttracker.service.LiveFeedBroadcaster;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Profile;
import org.springframework.web.socket.config.annotation.EnableWebSocket;
import org.springframework.web.socket.config.annotation.WebSocketConfigurer;
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry;

@Configuration
@EnableWebSocket
@Profile("api")
public class WebSocketConfig implements WebSocketConfigurer {

    private final LiveFeedBroadcaster broadcaster;

    public WebSocketConfig(LiveFeedBroadcaster broadcaster) {
        this.broadcaster = broadcaster;
    }

    @Override
    public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
        registry.addHandler(broadcaster, "/ws/live").setAllowedOrigins("*");
    }
}
