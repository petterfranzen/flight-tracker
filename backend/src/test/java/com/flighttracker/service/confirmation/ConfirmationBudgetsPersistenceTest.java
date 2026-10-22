package com.flighttracker.service.confirmation;

import com.flighttracker.config.SqliteDataSourceConfig;
import com.flighttracker.observability.PhaseLogger;
import com.flighttracker.repository.AppStateRepository;
import com.flighttracker.repository.AircraftRepository;
import com.flighttracker.service.coverage.RunwayIndex;
import com.flighttracker.service.enrichment.CallsignRouteService;
import com.flighttracker.service.live.LiveStateStore;
import com.flighttracker.service.training.TrainingDataService;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.context.annotation.AnnotationConfigApplicationContext;
import org.springframework.core.io.ClassPathResource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.init.ScriptUtils;
import org.springframework.mock.env.MockEnvironment;

import javax.sql.DataSource;
import java.io.Closeable;
import java.nio.file.Path;
import java.sql.Connection;
import java.time.Clock;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;

/**
 * The budgets against a real SQLite app_state (the temp-file pattern of
 * SqlitePersistenceIntegrationTest), through a simulated restart; plus a Spring
 * wiring check that the service starts while no board provider bean exists.
 */
class ConfirmationBudgetsPersistenceTest {

    @TempDir
    Path tempDir;

    private final List<DataSource> opened = new ArrayList<>();
    private TestClock clock;
    private MockEnvironment env;

    @BeforeEach
    void setUp() throws Exception {
        clock = new TestClock();
        clock.set(Instant.parse("2026-10-12T10:00:00Z"));
        env = new MockEnvironment();
        env.setProperty("flighttracker.confirmation.providers.adb.monthly-budget", "10");
        env.setProperty("flighttracker.confirmation.providers.adb.daily-budget", "6");
        DataSource first = open();
        try (Connection connection = first.getConnection()) {
            ScriptUtils.executeSqlScript(connection, new ClassPathResource("schema.sql"));
        }
    }

    @AfterEach
    void tearDown() {
        for (DataSource ds : opened) {
            if (ds instanceof Closeable closeable) {
                try {
                    closeable.close();
                } catch (Exception ignored) {
                }
            }
        }
    }

    private DataSource open() {
        DataSource ds = SqliteDataSourceConfig.buildDataSource(tempDir.resolve("budgets.db").toString());
        opened.add(ds);
        return ds;
    }

    /** A fresh process: new connection pool, new repository, new budgets, same file. */
    private ConfirmationBudgets boot() {
        AppStateRepository appState = new AppStateRepository(new JdbcTemplate(open()), clock);
        return new ConfirmationBudgets(appState, clock, env, new PhaseLogger(), 300);
    }

    @Test
    void theCountersSurviveARestart_soTheMonthlyQuotaCannotBeOverspent() {
        ConfirmationBudgets before = boot();
        before.tryCharge("adb", 2);
        before.tryCharge("adb", 2);

        ConfirmationBudgets after = boot();

        assertThat(after.unitsToday("adb")).isEqualTo(4);
        assertThat(after.unitsThisMonth("adb")).isEqualTo(4);
        assertThat(after.tryCharge("adb", 3)).isFalse(); // 4 + 3 > 6 today
        assertThat(after.tryCharge("adb", 2)).isTrue();

        clock.set(Instant.parse("2026-10-13T00:00:01Z")); // next day: the daily budget is back, the month's 6 stay
        ConfirmationBudgets nextDay = boot();
        assertThat(nextDay.unitsToday("adb")).isZero();
        assertThat(nextDay.unitsThisMonth("adb")).isEqualTo(6);
        assertThat(nextDay.tryCharge("adb", 5)).isFalse(); // 6 + 5 > 10
        assertThat(nextDay.tryCharge("adb", 4)).isTrue();

        clock.set(Instant.parse("2026-11-01T00:00:01Z"));
        assertThat(boot().unitsThisMonth("adb")).isZero();
    }

    @Test
    void aBoardFetchIsChargedAndPersistedThroughTheGateway() {
        ConfirmationBudgets budgets = boot();
        ConfirmationGateway gateway = new ConfirmationGateway(clock, 0, budgets, 100, 300, 60, 300, 100);
        AirportArrivalsProvider provider = new AirportArrivalsProvider() {
            @Override public String id() { return "adb"; }
            @Override public boolean covers(String airport) { return true; }
            @Override public BoardResult fetchArrivals(String airport, java.time.LocalDate dateUtc) {
                return BoardResult.found(List.of()).withCost(3);
            }
        };

        gateway.board(provider, "ESSA", java.time.LocalDate.parse("2026-10-12"));

        ConfirmationBudgets after = boot();
        assertThat(after.unitsToday("adb")).isEqualTo(3);
        assertThat(after.unitsThisMonth("adb")).isEqualTo(3);
    }

    @Test
    void theServiceIsWiredBySpring_whenNoBoardProviderBeanExists() {
        try (AnnotationConfigApplicationContext ctx = new AnnotationConfigApplicationContext()) {
            ctx.registerBean(Clock.class, () -> clock);
            ctx.registerBean(MockArrivalProvider.class, () -> new MockArrivalProvider(clock, false, 0.2));
            ctx.registerBean(ConfirmationGateway.class, () -> new ConfirmationGateway(clock, 30, InMemoryAppState.budgets(clock, 300),
                    100, 300, 60, 300, 100));
            ctx.registerBean(ConfirmationStore.class, () -> new ConfirmationStore(120, 100));
            ctx.registerBean(LiveStateStore.class, () -> mock(LiveStateStore.class));
            ctx.registerBean(CallsignRouteService.class, () -> mock(CallsignRouteService.class));
            ctx.registerBean(RunwayIndex.class, RunwayIndex::new);
            ctx.registerBean(TrainingDataService.class, () -> mock(TrainingDataService.class));
            ctx.registerBean(AircraftRepository.class, () -> mock(AircraftRepository.class));
            ctx.registerBean(ArrivalConfirmationService.class);

            ctx.refresh();

            assertThat(ctx.getBean(ArrivalConfirmationService.class)).isNotNull();
        }
    }
}
