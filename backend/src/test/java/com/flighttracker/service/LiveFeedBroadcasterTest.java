package com.flighttracker.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.flighttracker.model.FlightPosition;
import com.flighttracker.service.live.PositionsPersistedEvent;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.context.annotation.AnnotationConfigApplicationContext;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketMessage;
import org.springframework.web.socket.WebSocketSession;

import java.time.Instant;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.lenient;
import static org.mockito.Mockito.mock;
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
    private final LiveFeedBroadcaster broadcaster = new LiveFeedBroadcaster(new ObjectMapper().findAndRegisterModules(), viewport);

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
            ctx.registerBean(ObjectMapper.class, () -> new ObjectMapper().findAndRegisterModules());
            ctx.registerBean(ViewportService.class);
            ctx.registerBean(LiveFeedBroadcaster.class);
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
