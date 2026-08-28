package com.flighttracker.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.flighttracker.model.FlightPosition;
import org.springframework.context.annotation.Profile;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.TextWebSocketHandler;

import java.io.IOException;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Fans out each newly-persisted position to every connected map client —
 * filtered to the current viewport (see ViewportService), since tracking
 * is now global and a client only wants pushes for what's actually on its
 * screen. Same single-shared-viewport simplification as ViewportService
 * itself: every connected session gets the same filter, not a per-session
 * one.
 *
 * "api"-only: positions are written by the "agent" container, which
 * reaches this one via PositionNotificationListener, not a direct call.
 */
@Component
@Profile("api")
public class LiveFeedBroadcaster extends TextWebSocketHandler {

    private final Map<String, WebSocketSession> sessions = new ConcurrentHashMap<>();
    private final ViewportService viewportService;

    // Inject Spring Boot's autoconfigured ObjectMapper bean — the exact same
    // one the REST controllers serialize through — rather than building a
    // second one by hand. A hand-built mapper has to be kept in sync flag by
    // flag with whatever Jackson customization Spring applies; the shared
    // bean makes WS and REST serialize identically by construction instead.
    private final ObjectMapper mapper;

    public LiveFeedBroadcaster(ObjectMapper mapper, ViewportService viewportService) {
        this.mapper = mapper;
        this.viewportService = viewportService;
    }

    @Override
    public void afterConnectionEstablished(WebSocketSession session) {
        sessions.put(session.getId(), session);
    }

    @Override
    public void afterConnectionClosed(WebSocketSession session, org.springframework.web.socket.CloseStatus status) {
        sessions.remove(session.getId());
    }

    public void publish(FlightPosition position) {
        if (sessions.isEmpty()) return;
        if (!viewportService.currentCached().contains(position.getLatitude(), position.getLongitude())) return;
        try {
            String json = mapper.writeValueAsString(position);
            TextMessage message = new TextMessage(json);
            sessions.values().forEach(s -> {
                try {
                    if (s.isOpen()) s.sendMessage(message);
                } catch (IOException ignored) {
                    // a dead client will get pruned on its own close event
                }
            });
        } catch (IOException ignored) {
        }
    }
}
