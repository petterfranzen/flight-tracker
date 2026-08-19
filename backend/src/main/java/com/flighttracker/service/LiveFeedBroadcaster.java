package com.flighttracker.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.flighttracker.model.FlightPosition;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.TextWebSocketHandler;

import java.io.IOException;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/** Fans out each newly-persisted position to every connected map client. */
@Component
public class LiveFeedBroadcaster extends TextWebSocketHandler {

    private final Map<String, WebSocketSession> sessions = new ConcurrentHashMap<>();

    // Deliberately the same shape as Spring's autoconfigured REST ObjectMapper
    // (which disables WRITE_DATES_AS_TIMESTAMPS by default) rather than
    // Jackson's raw default — otherwise Instant fields like observedAt come
    // out as a numeric epoch over the WebSocket while /api/flights/* renders
    // the exact same FlightPosition's observedAt as an ISO-8601 string, and
    // any client trusting one shape breaks the moment it reads the other.
    private final ObjectMapper mapper = new ObjectMapper()
            .findAndRegisterModules()
            .disable(com.fasterxml.jackson.databind.SerializationFeature.WRITE_DATES_AS_TIMESTAMPS);

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
