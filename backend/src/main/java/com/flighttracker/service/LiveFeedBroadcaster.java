package com.flighttracker.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.flighttracker.model.FlightPosition;
import com.flighttracker.service.live.PositionsPersistedEvent;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.transaction.event.TransactionPhase;
import org.springframework.transaction.event.TransactionalEventListener;
import org.springframework.web.socket.PingMessage;
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
 * Fed by PositionPersistenceService.persist() via PositionsPersistedEvent —
 * an earlier, multi-container version of this app had positions written by
 * a separate "agent" container and bridged here over a Postgres pub/sub
 * channel (see PositionsPersistedEvent's javadoc); now both live in this
 * one process, so a plain in-process event does the same job.
 *
 * Also keeps every connection alive (sendKeepalive, cloud migration A1 —
 * PLAN.md §6 item 9): Cloudflare Tunnel closes a WebSocket idle for
 * roughly 100s, and a quiet map (nothing in view, or the poll window
 * closed) can easily go that long with nothing to broadcast.
 */
@Component
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

    /**
     * AFTER_COMMIT so a broadcast never fires for a write that then rolled
     * back — same guarantee Postgres's own commit-gated pub/sub delivery
     * gave for free in the old cross-container design. fallbackExecution
     * = true is the "plain event-listener fallback" the migration plan
     * calls for: if this is ever published outside an active transaction
     * (there's no reason it should be, since PositionPersistenceService.
     * persist() is @Transactional, but a defensive default costs nothing),
     * this still runs immediately instead of the event being silently
     * dropped.
     */
    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT, fallbackExecution = true)
    public void onPositionsPersisted(PositionsPersistedEvent event) {
        for (FlightPosition position : event.positions()) {
            publish(position);
        }
    }

    // Cloudflare Tunnel's own idle-close window (~100s) is what this
    // guards against — 30s leaves a comfortable multiple of margin even
    // accounting for network jitter or a slow client, while still being
    // infrequent enough not to matter as traffic.
    //
    // A native WebSocket ping frame, not a JSON text frame: browsers
    // handle the control-frame ping/pong handshake entirely inside the
    // WebSocket implementation itself, transparent to application JS
    // (it never reaches subscribeLiveFeed's onmessage handler in
    // flightApi.ts) — so this needs no frontend change or coordination.
    // See the hand-off report if a non-browser client ever needs the
    // {"type":"ping"} text-frame fallback PLAN.md §6 item 9 mentions
    // instead — not needed for this repo's own frontend.
    @Scheduled(fixedDelay = 30_000)
    void sendKeepalive() {
        if (sessions.isEmpty()) return;
        PingMessage ping = new PingMessage();
        sessions.values().forEach(s -> {
            try {
                if (s.isOpen()) s.sendMessage(ping);
            } catch (IOException ignored) {
                // a dead client will get pruned on its own close event
            }
        });
    }

    private void publish(FlightPosition position) {
        if (sessions.isEmpty()) return;
        if (!viewportService.currentCached().contains(position.latitude(), position.longitude())) return;
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
