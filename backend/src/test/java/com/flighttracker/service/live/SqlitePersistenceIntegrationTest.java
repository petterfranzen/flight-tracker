package com.flighttracker.service.live;

import com.flighttracker.config.SqliteDataSourceConfig;
import com.flighttracker.model.FlightPosition;
import com.flighttracker.repository.AircraftRepository;
import com.flighttracker.repository.FlightPositionRepository;
import com.flighttracker.service.agent.PositionRetentionService;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.core.io.ClassPathResource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.init.ScriptUtils;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.transaction.support.TransactionTemplate;

import javax.sql.DataSource;
import java.io.Closeable;
import java.nio.file.Path;
import java.sql.Connection;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Cloud migration A2 (PLAN.md §6 item 8): "integration tests against a
 * temp-file SQLite (no Testcontainers): insert -> live read -> retention
 * -> vacuum; the retention test uses a fixed Clock." A real SQLite file
 * under JUnit's @TempDir, the exact same pooled DataSource/PRAGMA setup a
 * real boot gets (SqliteDataSourceConfig.buildDataSource — not a
 * hand-rolled approximation), and schema.sql run against it unmodified —
 * this is as close to "start the real app" as a fast, no-network,
 * no-container test gets.
 *
 * In package service.live (not a dedicated `integration` package)
 * specifically so this can call LiveStateStore.warmUp() directly — that
 * method is package-private, invoked only by Spring's @PostConstruct
 * machinery in production, and this test needs to invoke it manually at a
 * specific point in the insert -> live read -> retention -> vacuum flow
 * rather than only at bean-creation time.
 */
class SqlitePersistenceIntegrationTest {

    private DataSource dataSource;
    private JdbcTemplate jdbcTemplate;
    private JdbcClient jdbcClient;

    @TempDir
    Path tempDir;

    @BeforeEach
    void setUp() throws Exception {
        dataSource = SqliteDataSourceConfig.buildDataSource(tempDir.resolve("integration-test.db").toString());
        jdbcTemplate = new JdbcTemplate(dataSource);
        jdbcClient = JdbcClient.create(dataSource);
        try (Connection connection = dataSource.getConnection()) {
            ScriptUtils.executeSqlScript(connection, new ClassPathResource("schema.sql"));
        }
    }

    @AfterEach
    void tearDown() {
        if (dataSource instanceof Closeable closeable) {
            try {
                closeable.close();
            } catch (Exception ignored) {
            }
        }
    }

    @Test
    void insert_liveRead_retention_vacuum_endToEnd() {
        Instant t0 = Instant.parse("2026-01-01T00:00:00Z");
        Clock clock = Clock.fixed(t0, ZoneOffset.UTC);

        AircraftRepository aircraftRepository = new AircraftRepository(jdbcClient, clock);
        FlightPositionRepository positionRepository = new FlightPositionRepository(jdbcClient, clock);
        LiveStateStore liveStateStore = new LiveStateStore(jdbcTemplate, clock);

        // --- insert ---
        aircraftRepository.insertIfAbsent("abc123");
        assertThat(aircraftRepository.existsById("abc123")).isTrue();

        Instant t1 = t0.minusSeconds(3600); // 1h before "now" for this test's clock
        var inserted = positionRepository.insertIgnoringDuplicate(
                "abc123", "SAS100", t1, 59.0, 18.0,
                10_000.0, 200.0, 90.0, 0.0, false, "opensky");
        assertThat(inserted).isPresent();
        assertThat(inserted.get().icao24()).isEqualTo("abc123");

        // A duplicate (icao24, observed_at, agent_source) must be a no-op, not an error.
        var duplicate = positionRepository.insertIgnoringDuplicate(
                "abc123", "SAS100", t1, 59.0, 18.0,
                10_000.0, 200.0, 90.0, 0.0, false, "opensky");
        assertThat(duplicate).isEmpty();

        Long count = jdbcTemplate.queryForObject("SELECT COUNT(*) FROM flight_position", Long.class);
        assertThat(count).isEqualTo(1L);

        // --- live read ---
        // warmUp() reads flight_position directly (not through liveStateStore.upsert()),
        // pinning down that the SQLite rewrite of that warm-up query (ROW_NUMBER()
        // instead of Postgres's DISTINCT ON, epoch-millis instead of TIMESTAMPTZ) is
        // actually correct against a real database, not just unit-tested in isolation.
        liveStateStore.warmUp();
        Instant now = clock.instant();
        List<FlightPosition> live = liveStateStore.liveFlightPositions(
                now.minusSeconds(48 * 3600), now.minusSeconds(48 * 3600), null);
        assertThat(live).hasSize(1);
        assertThat(live.get(0).icao24()).isEqualTo("abc123");
        assertThat(live.get(0).latitude()).isEqualTo(59.0);

        // --- retention ---
        // t1 is 1h old relative to this test's fixed clock; a 0.5h retention
        // window means it's past due for deletion.
        TransactionTemplate transactionTemplate = new TransactionTemplate(new DataSourceTransactionManager(dataSource));
        PositionRetentionService retentionService = new PositionRetentionService(
                jdbcTemplate, aircraftRepository, transactionTemplate, clock, liveStateStore);
        setField(retentionService, "retentionHours", 0.5);
        setField(retentionService, "batchSize", 5000);
        setField(retentionService, "maxBatchesPerRun", 200);

        retentionService.prune();

        Long countAfterPrune = jdbcTemplate.queryForObject("SELECT COUNT(*) FROM flight_position", Long.class);
        assertThat(countAfterPrune).isEqualTo(0L);

        // --- vacuum ---
        // prune() itself already ran PRAGMA incremental_vacuum/wal_checkpoint
        // when it deleted rows (see PositionRetentionService.prune's own
        // logic) — this just confirms those pragmas are valid statements
        // against this real database (they'd throw on a syntax/support
        // problem) and the connection is still usable afterwards.
        jdbcTemplate.execute("PRAGMA incremental_vacuum(2000)");
        jdbcTemplate.execute("PRAGMA wal_checkpoint(TRUNCATE)");
        jdbcTemplate.execute("PRAGMA optimize");
        Long stillUsable = jdbcTemplate.queryForObject("SELECT COUNT(*) FROM flight_position", Long.class);
        assertThat(stillUsable).isEqualTo(0L);
    }

    @Test
    void warmUp_restoresEachAircraftsNewestReport_andWhenItsCurrentGroundStreakBegan() {
        Instant t0 = Instant.parse("2026-01-01T00:00:00Z");
        Clock clock = Clock.fixed(t0, ZoneOffset.UTC);
        AircraftRepository aircraftRepository = new AircraftRepository(jdbcClient, clock);
        FlightPositionRepository positions = new FlightPositionRepository(jdbcClient, clock);
        LiveStateStore store = new LiveStateStore(jdbcTemplate, clock);

        // (icao24, minutes before "now", on the ground?) in time order per aircraft.
        Object[][] reports = {
                // Airborne at its newest report: no streak.
                {"air001", 300, false}, {"air001", 200, false}, {"air001", 10, false},
                // Flew, then landed and stayed: the streak began at the first ground report.
                {"gnd001", 300, false}, {"gnd001", 280, false}, {"gnd001", 260, true}, {"gnd001", 250, true}, {"gnd001", 240, true},
                // Ground, air, ground again (a taxi hop): the streak is the last ground run.
                {"flk001", 300, true}, {"flk001", 280, false}, {"flk001", 260, true}, {"flk001", 250, true},
                // Only ever seen on the ground in the window: the first ground report.
                {"onl001", 200, true}, {"onl001", 190, true},
                // A ground report from before the 24 h window is ignored; the streak starts in the window.
                {"pre001", 30 * 60, true}, {"pre001", 60, true}, {"pre001", 30, true},
        };
        for (Object[] r : reports) {
            aircraftRepository.insertIfAbsent((String) r[0]);
            positions.insertIgnoringDuplicate((String) r[0], "CS" + r[0], t0.minusSeconds(60L * (int) r[1]), 59.0, 18.0,
                    (boolean) r[2] ? 0.0 : 10_000.0, (boolean) r[2] ? 0.0 : 200.0, 90.0, 0.0, (boolean) r[2], "opensky");
        }

        store.warmUp();

        assertThat(store.get("air001")).hasValueSatisfying(a -> {
            assertThat(a.observedAt()).isEqualTo(t0.minusSeconds(60L * 10));
            assertThat(a.onGround()).isFalse();
            assertThat(a.landedSince()).isNull();
        });
        assertThat(store.get("gnd001")).hasValueSatisfying(a -> {
            assertThat(a.observedAt()).isEqualTo(t0.minusSeconds(60L * 240));
            assertThat(a.onGround()).isTrue();
            assertThat(a.landedSince()).isEqualTo(t0.minusSeconds(60L * 260));
        });
        assertThat(store.get("flk001")).hasValueSatisfying(a -> assertThat(a.landedSince()).isEqualTo(t0.minusSeconds(60L * 260)));
        assertThat(store.get("onl001")).hasValueSatisfying(a -> assertThat(a.landedSince()).isEqualTo(t0.minusSeconds(60L * 200)));
        assertThat(store.get("pre001")).hasValueSatisfying(a -> assertThat(a.landedSince()).isEqualTo(t0.minusSeconds(60L * 60)));
    }

    @Test
    void retention_alsoPrunesAircraftWithNoRemainingPositionsAfterSevenDays() {
        Instant t0 = Instant.parse("2026-01-10T00:00:00Z");
        Clock clock = Clock.fixed(t0, ZoneOffset.UTC);
        AircraftRepository aircraftRepository = new AircraftRepository(jdbcClient, clock);

        // An aircraft "first seen" 8 days before this test's fixed clock, with
        // no flight_position rows at all — deleteStaleWithNoPositions' target case.
        jdbcTemplate.update("INSERT INTO aircraft (icao24, first_seen_at, last_seen_at) VALUES (?, ?, ?)",
                "old001", t0.minusSeconds(8L * 24 * 3600).toEpochMilli(), t0.minusSeconds(8L * 24 * 3600).toEpochMilli());
        // A recently-seen aircraft that must survive.
        aircraftRepository.insertIfAbsent("new001");

        int deleted = aircraftRepository.deleteStaleWithNoPositions(t0.minusSeconds(7L * 24 * 3600));

        assertThat(deleted).isEqualTo(1);
        assertThat(aircraftRepository.existsById("old001")).isFalse();
        assertThat(aircraftRepository.existsById("new001")).isTrue();
    }

    private static void setField(Object target, String fieldName, Object value) {
        try {
            var field = target.getClass().getDeclaredField(fieldName);
            field.setAccessible(true);
            field.set(target, value);
        } catch (ReflectiveOperationException e) {
            throw new RuntimeException(e);
        }
    }
}
