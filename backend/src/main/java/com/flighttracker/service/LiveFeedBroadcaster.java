package com.flighttracker.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.flighttracker.model.FlightPosition;
import com.flighttracker.service.live.PositionsPersistedEvent;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.transaction.event.TransactionPhase;
import org.springframework.transaction.event.TransactionalEventListener;
import com.flighttracker.dto.Bounds;
import com.flighttracker.dto.LiveFrame;
import jakarta.annotation.PreDestroy;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.web.context.WebServerGracefulShutdownLifecycle;
import org.springframework.context.SmartLifecycle;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.PingMessage;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.ConcurrentWebSocketSessionDecorator;
import org.springframework.web.socket.handler.SessionLimitExceededException;
import org.springframework.web.socket.handler.TextWebSocketHandler;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

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
 *
 * Every send goes through a per-session ConcurrentWebSocketSessionDecorator
 * on a virtual thread, never directly on the caller's thread. Before this,
 * sendMessage() was a blocking write on the persistence thread: one client
 * that stopped reading (a browser whose main thread is saturated stops
 * reading under WebSocket flow control) stalled the broadcast to *every*
 * client, and the poll that triggered it, for Tomcat's ~20s write timeout
 * per message — reproduced locally as a 19s gap on a healthy client — and
 * the 30s keepalive ping could race a broadcast on the same session, which
 * Tomcat rejects with IllegalStateException (TEXT_PARTIAL_WRITING). Now a
 * slow client only fills its own bounded buffer (oldest frames dropped; the
 * map's periodic /live reconcile covers the gap), and one that can't drain
 * within SEND_TIME_LIMIT_MS is closed with 1011 so its client reconnects
 * cleanly instead of hanging half-open.
 *
 * On shutdown (every deploy restarts the service) every session is closed
 * with 1001 going-away, so browsers start reconnecting at once instead of
 * waiting to notice a dead socket. See stop().
 */
@Component
public class LiveFeedBroadcaster extends TextWebSocketHandler implements SmartLifecycle {

    private static final Logger log = LoggerFactory.getLogger(LiveFeedBroadcaster.class);

    // A client that hasn't drained a send in this long is gone for practical
    // purposes — close it (1011) and let it reconnect.
    static final int SEND_TIME_LIMIT_MS = 10_000;
    // ~4k position frames. Beyond that the oldest are dropped, not the session.
    static final int BUFFER_SIZE_LIMIT_BYTES = 1024 * 1024;
    // Lifecycle stop runs from the highest phase down. This sits between the
    // graceful-shutdown phase (server socket closed, in-flight requests
    // drained) and the phase that stops Tomcat, so a client told to go away
    // can't reconnect to this instance, and Tomcat is still up to send the
    // close frame.
    static final int SHUTDOWN_PHASE = WebServerGracefulShutdownLifecycle.SMART_LIFECYCLE_PHASE - 512;
    // Upper bound on waiting for close frames on shutdown. A close queues
    // behind a stalled client's blocked write, so it can't be open-ended.
    static final long CLOSE_TIMEOUT_MS = 2_000;

    // Decorated sessions, keyed by the raw session's id.
    private final Map<String, WebSocketSession> sessions = new ConcurrentHashMap<>();
    private final ExecutorService sendExecutor = Executors.newVirtualThreadPerTaskExecutor();
    private final ViewportService viewportService;
    private volatile boolean running;
    private volatile boolean stopping;

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
        if (stopping) {
            closeQuietly(session, CloseStatus.GOING_AWAY);
            return;
        }
        sessions.put(session.getId(), new ConcurrentWebSocketSessionDecorator(
                session, SEND_TIME_LIMIT_MS, BUFFER_SIZE_LIMIT_BYTES,
                ConcurrentWebSocketSessionDecorator.OverflowStrategy.DROP));
    }

    @Override
    public void afterConnectionClosed(WebSocketSession session, CloseStatus status) {
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
        if (sessions.isEmpty()) return;
        Bounds viewport = viewportService.currentCached();
        List<TextMessage> messages = new ArrayList<>();
        for (FlightPosition position : event.positions()) {
            if (!viewport.contains(position.latitude(), position.longitude())) continue;
            try {
                messages.add(new TextMessage(mapper.writeValueAsString(LiveFrame.of(position))));
            } catch (IOException e) {
                log.debug("Skipping unserializable position {}: {}", position.icao24(), e.toString());
            }
        }
        if (messages.isEmpty()) return;
        sessions.values().forEach(s -> sendExecutor.execute(() -> sendAll(s, messages)));
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
        List<WebSocketMessage<?>> ping = List.of(new PingMessage());
        sessions.values().forEach(s -> sendExecutor.execute(() -> sendAll(s, ping)));
    }

    /**
     * Sends in order through the session's decorator. When another thread is
     * already flushing this session, sendMessage() just buffers and returns,
     * so only one virtual thread per session ever blocks on a slow socket.
     */
    void sendAll(WebSocketSession session, List<? extends WebSocketMessage<?>> messages) {
        for (WebSocketMessage<?> message : messages) {
            if (!session.isOpen()) return;
            try {
                session.sendMessage(message);
            } catch (SessionLimitExceededException e) {
                log.debug("Closing slow WebSocket client {}: {}", session.getId(), e.getMessage());
                closeQuietly(session, e.getStatus());
                return;
            } catch (IOException | RuntimeException e) {
                log.debug("Closing WebSocket client {} after send failure: {}", session.getId(), e.toString());
                closeQuietly(session, CloseStatus.SESSION_NOT_RELIABLE);
                return;
            }
        }
    }

    private void closeQuietly(WebSocketSession session, CloseStatus status) {
        sessions.remove(session.getId());
        try {
            session.close(status);
        } catch (IOException | RuntimeException ignored) {
            // already gone
        }
    }

    @Override
    public void start() {
        running = true;
    }

    @Override
    public boolean isRunning() {
        return running;
    }

    @Override
    public int getPhase() {
        return SHUTDOWN_PHASE;
    }

    /**
     * Closes every session with 1001 going-away. Closes run in parallel on
     * the send executor and are waited for at most CLOSE_TIMEOUT_MS, so one
     * stalled client can't hold up shutdown; shutdown() interrupts any left.
     */
    @Override
    public void stop() {
        stopping = true;
        running = false;
        List<WebSocketSession> open = new ArrayList<>(sessions.values());
        sessions.clear();
        if (open.isEmpty()) return;
        CompletableFuture<?>[] closes = open.stream()
                .map(s -> CompletableFuture.runAsync(() -> closeQuietly(s, CloseStatus.GOING_AWAY), sendExecutor))
                .toArray(CompletableFuture[]::new);
        try {
            CompletableFuture.allOf(closes).get(CLOSE_TIMEOUT_MS, TimeUnit.MILLISECONDS);
            log.info("Closed {} live feed WebSocket session(s) for shutdown", open.size());
        } catch (TimeoutException e) {
            log.info("Closed live feed WebSocket sessions for shutdown; gave up waiting on some after {} ms", CLOSE_TIMEOUT_MS);
        } catch (Exception e) {
            if (e instanceof InterruptedException) Thread.currentThread().interrupt();
            log.debug("Interrupted closing WebSocket sessions for shutdown: {}", e.toString());
        }
    }

    // Virtual threads are daemon threads, so anything still running here
    // can't hold up JVM exit either way.
    @PreDestroy
    void shutdown() {
        sendExecutor.shutdownNow();
    }
}
