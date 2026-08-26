package com.flighttracker.service;

import com.flighttracker.repository.FlightPositionRepository;
import jakarta.annotation.PostConstruct;
import jakarta.annotation.PreDestroy;
import org.postgresql.PGConnection;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Profile;
import org.springframework.stereotype.Component;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Bridges the "agent" container's writes to this ("api") container's
 * WebSocket clients — now that polling and API-serving are separate
 * processes, they can no longer share LiveFeedBroadcaster in memory, and
 * this stands in for that direct call. Uses Postgres's own LISTEN/NOTIFY
 * (see AgentOrchestrator.persist()) rather than a new broker: the data
 * volume is one small payload per new position, delivery only happens
 * once the writing transaction commits, and this thread blocks in
 * getNotifications() rather than polling.
 *
 * Deliberately a raw, unpooled JDBC connection: LISTEN registers on a
 * specific connection, not the database as a whole, so this needs to hold
 * the *same* connection open for as long as the container runs — something
 * a HikariCP-managed connection (reclaimed/rotated by the pool) can't do.
 */
@Component
@Profile("api")
public class PositionNotificationListener implements Runnable {

    private static final Logger log = LoggerFactory.getLogger(PositionNotificationListener.class);
    private static final String CHANNEL = "flight_position";
    private static final int POLL_TIMEOUT_MS = 5_000; // how often the loop checks for shutdown between notifications
    private static final long RECONNECT_DELAY_MS = 5_000;

    private final String url;
    private final String username;
    private final String password;
    private final FlightPositionRepository positionRepository;
    private final LiveFeedBroadcaster broadcaster;
    private final AtomicBoolean running = new AtomicBoolean(true);

    private Thread thread;
    private volatile Connection connection;

    public PositionNotificationListener(
            @Value("${spring.datasource.url}") String url,
            @Value("${spring.datasource.username}") String username,
            @Value("${spring.datasource.password}") String password,
            FlightPositionRepository positionRepository,
            LiveFeedBroadcaster broadcaster) {
        this.url = url;
        this.username = username;
        this.password = password;
        this.positionRepository = positionRepository;
        this.broadcaster = broadcaster;
    }

    @PostConstruct
    void start() {
        thread = new Thread(this, "flight-position-listener");
        thread.setDaemon(true);
        thread.start();
    }

    @Override
    public void run() {
        while (running.get()) {
            try {
                connect();
                PGConnection pg = connection.unwrap(PGConnection.class);
                while (running.get()) {
                    var notifications = pg.getNotifications(POLL_TIMEOUT_MS);
                    if (notifications == null) continue;
                    for (var notification : notifications) {
                        try {
                            long id = Long.parseLong(notification.getParameter());
                            positionRepository.findById(id).ifPresent(broadcaster::publish);
                        } catch (NumberFormatException e) {
                            log.warn("Unparseable position id in NOTIFY payload: {}", notification.getParameter());
                        }
                    }
                }
            } catch (Exception e) {
                if (!running.get()) return;
                log.warn("Position listener lost its connection, reconnecting in {}ms: {}", RECONNECT_DELAY_MS, e.toString());
                closeQuietly();
                sleepQuietly(RECONNECT_DELAY_MS);
            }
        }
    }

    private void connect() throws SQLException {
        connection = DriverManager.getConnection(url, username, password);
        try (Statement statement = connection.createStatement()) {
            statement.execute("LISTEN " + CHANNEL);
        }
        log.info("Listening for new positions on Postgres channel '{}'", CHANNEL);
    }

    private void closeQuietly() {
        try {
            if (connection != null) connection.close();
        } catch (SQLException ignored) {
        }
    }

    private void sleepQuietly(long millis) {
        try {
            Thread.sleep(millis);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    @PreDestroy
    void stop() {
        running.set(false);
        closeQuietly();
        if (thread != null) thread.interrupt();
    }
}
