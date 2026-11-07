package com.flighttracker.service;

import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.ObjectMapper;
import com.flighttracker.model.FlightPosition;
import com.flighttracker.service.live.PositionsPersistedEvent;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.context.annotation.AnnotationConfigApplicationContext;
import org.springframework.http.HttpHeaders;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.SessionLimitExceededException;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.lenient;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;

/**
 * A client that stops reading (a browser whose main thread is saturated
 * stops reading under WebSocket flow control) must not hold up delivery to
 * everyone else, or the thread that persisted the positions. Before the
 * per-session decorator + virtual-thread sends, onPositionsPersisted wrote
 * to each session inline and a stalled one blocked it for Tomcat's write
 * timeout per message.
 */
class LiveFeedBroadcasterTest {

    private final CountDownLatch release = new CountDownLatch(1);
    private final ViewportService viewport = new ViewportService();
    private final LiveFeedBroadcaster broadcaster = new LiveFeedBroadcaster(new JsonMapper(), viewport, new ClientIpResolver("127.0.0.1,::1"), 8);

    @AfterEach
    void tearDown() {
        release.countDown();
        broadcaster.shutdown();
    }

    @Test
    void stalledClientDoesNotBlockPublisherOrOtherClients() throws Exception {
        WebSocketSession stalled = session("stalled");
        doAnswer(inv -> {
            try {
                release.await(30, TimeUnit.SECONDS); // never drains while the test runs
            } catch (InterruptedException ignored) {
                // teardown
            }
            return null;
        }).when(stalled).sendMessage(any());

        List<String> received = new CopyOnWriteArrayList<>();
        CountDownLatch allDelivered = new CountDownLatch(50);
        WebSocketSession healthy = session("healthy");
        doAnswer(inv -> {
            received.add(((TextMessage) inv.getArgument(0)).getPayload());
            allDelivered.countDown();
            return null;
        }).when(healthy).sendMessage(any(WebSocketMessage.class));

        broadcaster.afterConnectionEstablished(stalled);
        broadcaster.afterConnectionEstablished(healthy);

        long start = System.nanoTime();
        for (int batch = 0; batch < 5; batch++) {
            broadcaster.onPositionsPersisted(new PositionsPersistedEvent(positions(batch * 10, 10)));
        }
        long publishMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - start);

        assertThat(publishMs).as("publisher thread must not wait on any client").isLessThan(1_000);
        assertThat(allDelivered.await(5, TimeUnit.SECONDS)).as("healthy client gets every frame despite the stalled one").isTrue();
        assertThat(received).hasSize(50);
    }

    @Test
    void positionsOutsideTheReportedViewportAreNotSent() throws Exception {
        WebSocketSession healthy = session("healthy");
        List<String> received = new CopyOnWriteArrayList<>();
        doAnswer(inv -> {
            received.add(((TextMessage) inv.getArgument(0)).getPayload());
            return null;
        }).when(healthy).sendMessage(any(WebSocketMessage.class));
        broadcaster.afterConnectionEstablished(healthy);

        FlightPosition inside = position("aaaaaa", 59.0, 18.0); // ViewportService's default is the Baltic
        FlightPosition outside = position("bbbbbb", 40.0, -74.0);
        broadcaster.onPositionsPersisted(new PositionsPersistedEvent(List.of(inside, outside)));

        Thread.sleep(300);
        assertThat(received).singleElement().asString().contains("aaaaaa");
    }

    @Test
    void framesCarryOnlyMarkerFields() throws Exception {
        WebSocketSession healthy = session("healthy");
        List<String> received = new CopyOnWriteArrayList<>();
        doAnswer(inv -> {
            received.add(((TextMessage) inv.getArgument(0)).getPayload());
            return null;
        }).when(healthy).sendMessage(any(WebSocketMessage.class));
        broadcaster.afterConnectionEstablished(healthy);

        broadcaster.onPositionsPersisted(new PositionsPersistedEvent(List.of(position("aaaaaa", 59.0, 18.0))));

        Thread.sleep(300);
        assertThat(received).singleElement().asString()
                .contains("\"icao24\"", "\"callsign\"", "\"observedAt\"", "\"latitude\"", "\"longitude\"", "\"headingDeg\"", "\"onGround\"")
                .doesNotContain("altitudeM", "velocityMs", "verticalRateMs", "agentSource", "\"id\"");
    }

    @Test
    void contextCloseClosesEverySessionWithGoingAway() throws Exception {
        WebSocketSession a = session("a");
        WebSocketSession b = session("b");
        try (AnnotationConfigApplicationContext ctx = new AnnotationConfigApplicationContext()) {
            ctx.registerBean(ObjectMapper.class, () -> new JsonMapper());
            ctx.registerBean(ViewportService.class);
            ctx.registerBean(LiveFeedBroadcaster.class, () -> new LiveFeedBroadcaster(
                    new JsonMapper(), new ViewportService(), new ClientIpResolver("127.0.0.1"), 8));
            ctx.refresh();
            LiveFeedBroadcaster live = ctx.getBean(LiveFeedBroadcaster.class);
            live.afterConnectionEstablished(a);
            live.afterConnectionEstablished(b);
        }
        verify(a).close(CloseStatus.GOING_AWAY);
        verify(b).close(CloseStatus.GOING_AWAY);
    }

    @Test
    void stalledClientDoesNotHoldUpShutdown() throws Exception {
        WebSocketSession stalled = session("stalled");
        doAnswer(inv -> {
            release.await(30, TimeUnit.SECONDS); // a close queued behind a blocked write
            return null;
        }).when(stalled).close(any());
        WebSocketSession healthy = session("healthy");
        broadcaster.afterConnectionEstablished(stalled);
        broadcaster.afterConnectionEstablished(healthy);

        long start = System.nanoTime();
        broadcaster.stop();
        long stopMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - start);

        assertThat(stopMs).isLessThan(LiveFeedBroadcaster.CLOSE_TIMEOUT_MS + 1_000);
        verify(healthy).close(CloseStatus.GOING_AWAY);
    }

    @Test
    void connectionArrivingAfterStopIsTurnedAway() throws Exception {
        broadcaster.stop();
        WebSocketSession late = session("late");
        broadcaster.afterConnectionEstablished(late);
        verify(late).close(CloseStatus.GOING_AWAY);
    }

    // ---- per-IP cap: every close path gives the slot back exactly once ----

    private static final String VISITOR = "203.0.113.9";
    private static final int CAP = 8;

    /** A session whose socket peer is loopback (cloudflared) and whose CF-Connecting-IP is ip. */
    private static WebSocketSession behindTunnel(String id, String ip) {
        WebSocketSession s = session(id);
        HttpHeaders headers = new HttpHeaders();
        headers.add("CF-Connecting-IP", ip);
        lenient().when(s.getHandshakeHeaders()).thenReturn(headers);
        lenient().when(s.getRemoteAddress()).thenReturn(new InetSocketAddress("127.0.0.1", 50000));
        return s;
    }

    private void connect(int count, String idPrefix) {
        for (int i = 0; i < count; i++) {
            broadcaster.afterConnectionEstablished(behindTunnel(idPrefix + i, VISITOR));
        }
    }

    @Test
    void connectionOverTheCapIsClosedWith1013AndOthersStay() throws Exception {
        List<WebSocketSession> held = new ArrayList<>();
        for (int i = 0; i < CAP; i++) {
            WebSocketSession s = behindTunnel("held" + i, VISITOR);
            held.add(s);
            broadcaster.afterConnectionEstablished(s);
        }
        WebSocketSession extra = behindTunnel("extra", VISITOR);
        broadcaster.afterConnectionEstablished(extra);

        verify(extra).close(CloseStatus.SERVICE_OVERLOAD);
        for (WebSocketSession s : held) verify(s, never()).close(any());
        assertThat(broadcaster.connectionsFor(VISITOR)).isEqualTo(CAP);
        assertThat(broadcaster.openSessions()).isEqualTo(CAP);

        // the refused socket's own close callback must not free someone else's slot
        broadcaster.afterConnectionClosed(extra, CloseStatus.SERVICE_OVERLOAD);
        assertThat(broadcaster.connectionsFor(VISITOR)).isEqualTo(CAP);

        // a closed connection frees exactly one slot
        broadcaster.afterConnectionClosed(held.get(0), CloseStatus.NORMAL);
        assertThat(broadcaster.connectionsFor(VISITOR)).isEqualTo(CAP - 1);
        WebSocketSession again = behindTunnel("again", VISITOR);
        broadcaster.afterConnectionEstablished(again);
        verify(again, never()).close(any());
    }

    @Test
    void otherIpsAreNotAffectedByOneIpsCap() throws Exception {
        connect(CAP, "a");
        WebSocketSession other = behindTunnel("other", "198.51.100.4");
        broadcaster.afterConnectionEstablished(other);
        verify(other, never()).close(any());
    }

    @Test
    void afterConnectionClosedReleasesOnce_evenWhenCalledTwice() {
        WebSocketSession a = behindTunnel("a", VISITOR);
        WebSocketSession b = behindTunnel("b", VISITOR);
        broadcaster.afterConnectionEstablished(a);
        broadcaster.afterConnectionEstablished(b);

        broadcaster.afterConnectionClosed(a, CloseStatus.NORMAL);
        broadcaster.afterConnectionClosed(a, CloseStatus.NORMAL);
        broadcaster.handleTransportError(a, new IOException("late"));

        assertThat(broadcaster.connectionsFor(VISITOR)).isEqualTo(1); // b still counted
    }

    @Test
    void transportErrorReleasesTheSlotEvenIfNoCloseCallbackFollows() {
        WebSocketSession a = behindTunnel("a", VISITOR);
        broadcaster.afterConnectionEstablished(a);
        broadcaster.handleTransportError(a, new IOException("reset"));
        assertThat(broadcaster.connectionsFor(VISITOR)).isZero();
        broadcaster.afterConnectionClosed(a, CloseStatus.SESSION_NOT_RELIABLE); // follows: no double release
        assertThat(broadcaster.connectionsFor(VISITOR)).isZero();
    }

    @Test
    void slowClientEvictionsReleaseTheirSlots_visitorIsNotLockedOutAfterManyDrops() throws Exception {
        // Diff C of the review leaked here: closeQuietly removed the session
        // before afterConnectionClosed ran, so the counter never came down.
        for (int round = 0; round < CAP + 4; round++) {
            WebSocketSession slow = behindTunnel("slow" + round, VISITOR);
            doAnswer(inv -> {
                throw new SessionLimitExceededException("buffer full", CloseStatus.SESSION_NOT_RELIABLE);
            }).when(slow).sendMessage(any());
            broadcaster.afterConnectionEstablished(slow);
            broadcaster.sendAll(slow, List.of(new TextMessage("x")));
            // the container then also reports the close; must not double-release
            broadcaster.afterConnectionClosed(slow, CloseStatus.SESSION_NOT_RELIABLE);
            verify(slow).close(CloseStatus.SESSION_NOT_RELIABLE);
        }
        assertThat(broadcaster.connectionsFor(VISITOR)).isZero();
        assertThat(broadcaster.openSessions()).isZero();

        WebSocketSession fresh = behindTunnel("fresh", VISITOR);
        broadcaster.afterConnectionEstablished(fresh);
        verify(fresh, never()).close(any());
        assertThat(broadcaster.connectionsFor(VISITOR)).isEqualTo(1);
    }

    @Test
    void evictionWithoutAnyCloseCallbackStillReleases() throws Exception {
        // closeQuietly alone (the connection is already dead, so the
        // container may never call afterConnectionClosed)
        for (int round = 0; round < CAP + 4; round++) {
            WebSocketSession s = behindTunnel("slow" + round, VISITOR);
            doAnswer(inv -> {
                throw new SessionLimitExceededException("buffer full", CloseStatus.SESSION_NOT_RELIABLE);
            }).when(s).sendMessage(any());
            broadcaster.afterConnectionEstablished(s);
            broadcaster.sendAll(s, List.of(new TextMessage("x")));
        }
        assertThat(broadcaster.connectionsFor(VISITOR)).isZero();
    }

    @Test
    void sendFailuresReleaseTheirSlots() throws Exception {
        for (int round = 0; round < CAP + 4; round++) {
            WebSocketSession s = behindTunnel("broken" + round, VISITOR);
            doAnswer(inv -> {
                throw new IOException("broken pipe");
            }).when(s).sendMessage(any());
            broadcaster.afterConnectionEstablished(s);
            broadcaster.sendAll(s, List.of(new TextMessage("x")));
            verify(s).close(CloseStatus.SESSION_NOT_RELIABLE);
        }
        assertThat(broadcaster.connectionsFor(VISITOR)).isZero();
        WebSocketSession fresh = behindTunnel("fresh", VISITOR);
        broadcaster.afterConnectionEstablished(fresh);
        verify(fresh, never()).close(any());
    }

    @Test
    void sendFailureThroughTheBroadcastPathReleases() throws Exception {
        WebSocketSession s = behindTunnel("broken", VISITOR);
        CountDownLatch tried = new CountDownLatch(1);
        doAnswer(inv -> {
            tried.countDown();
            throw new IOException("broken pipe");
        }).when(s).sendMessage(any());
        broadcaster.afterConnectionEstablished(s);

        broadcaster.onPositionsPersisted(new PositionsPersistedEvent(positions(0, 1)));

        assertThat(tried.await(5, TimeUnit.SECONDS)).isTrue();
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
        while (broadcaster.connectionsFor(VISITOR) != 0 && System.nanoTime() < deadline) Thread.sleep(10);
        assertThat(broadcaster.connectionsFor(VISITOR)).isZero();
    }

    @Test
    void shutdownReleasesEverySlot() {
        connect(3, "a");
        broadcaster.stop();
        assertThat(broadcaster.connectionsFor(VISITOR)).isZero();
        assertThat(broadcaster.openSessions()).isZero();
    }

    @Test
    void clientThatHungUpBeforeRegistrationDoesNotLeak() {
        WebSocketSession gone = behindTunnel("gone", VISITOR);
        lenient().when(gone.isOpen()).thenReturn(false);
        broadcaster.afterConnectionEstablished(gone);
        assertThat(broadcaster.connectionsFor(VISITOR)).isZero();
    }

    @Test
    void headersFromAnUntrustedPeerDoNotChangeTheKey() throws Exception {
        // The socket peer is not the tunnel: CF-Connecting-IP / XFF are
        // client input, so rotating them must not buy extra slots.
        for (int i = 0; i < CAP + 5; i++) {
            WebSocketSession s = session("spoof" + i);
            HttpHeaders headers = new HttpHeaders();
            headers.add("CF-Connecting-IP", "10.9.9." + i);
            headers.add("X-Forwarded-For", "10.8.8." + i);
            lenient().when(s.getHandshakeHeaders()).thenReturn(headers);
            lenient().when(s.getRemoteAddress()).thenReturn(new InetSocketAddress("198.51.100.77", 4000 + i));
            broadcaster.afterConnectionEstablished(s);
            if (i >= CAP) verify(s).close(CloseStatus.SERVICE_OVERLOAD);
        }
        assertThat(broadcaster.connectionsFor("198.51.100.77")).isEqualTo(CAP);
    }

    @Test
    void capOfZeroDisablesTheLimit() {
        LiveFeedBroadcaster unlimited = new LiveFeedBroadcaster(new JsonMapper(), viewport,
                new ClientIpResolver("127.0.0.1"), 0);
        try {
            for (int i = 0; i < 30; i++) unlimited.afterConnectionEstablished(behindTunnel("u" + i, VISITOR));
            assertThat(unlimited.connectionsFor(VISITOR)).isEqualTo(30);
        } finally {
            unlimited.shutdown();
        }
    }

    @Test
    void concurrentConnectsNeverExceedTheCap() throws Exception {
        int attempts = 64;
        java.util.concurrent.ExecutorService pool = java.util.concurrent.Executors.newFixedThreadPool(16);
        CountDownLatch go = new CountDownLatch(1);
        List<WebSocketSession> all = new ArrayList<>();
        for (int i = 0; i < attempts; i++) all.add(behindTunnel("c" + i, VISITOR));
        List<java.util.concurrent.Future<?>> futures = new ArrayList<>();
        for (WebSocketSession s : all) {
            futures.add(pool.submit(() -> {
                go.await();
                broadcaster.afterConnectionEstablished(s);
                return null;
            }));
        }
        go.countDown();
        for (var f : futures) f.get(10, TimeUnit.SECONDS);
        pool.shutdown();
        assertThat(broadcaster.connectionsFor(VISITOR)).isEqualTo(CAP);
        assertThat(broadcaster.openSessions()).isEqualTo(CAP);
    }

    private static WebSocketSession session(String id) {
        WebSocketSession s = mock(WebSocketSession.class);
        lenient().when(s.getId()).thenReturn(id);
        lenient().when(s.isOpen()).thenReturn(true);
        return s;
    }

    private static List<FlightPosition> positions(int from, int count) {
        return java.util.stream.IntStream.range(from, from + count)
                .mapToObj(i -> position(String.format("%06x", i), 59.0, 18.0))
                .toList();
    }

    private static FlightPosition position(String icao24, double lat, double lon) {
        return new FlightPosition(null, icao24, "TST1", Instant.parse("2026-10-01T12:00:00Z"),
                lat, lon, 10_000.0, 230.0, 90.0, 0.0, false, "test");
    }
}
