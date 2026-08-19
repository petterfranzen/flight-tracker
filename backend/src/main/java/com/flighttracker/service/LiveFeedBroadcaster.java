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

    // Inject Spring Boot's autoconfigured ObjectMapper bean — the exact same
    // one the REST controllers serialize through — rather than building a
    // second one by hand. A hand-built mapper has to be kept in sync flag by
    // flag with whatever Jackson customization Spring applies; the shared
    // bean makes WS and REST serialize identically by construction instead.
    private final ObjectMapper mapper;

    public LiveFeedBroadcaster(ObjectMapper mapper) {
        this.mapper = mapper;
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
