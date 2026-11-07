package com.flighttracker.repository;

import com.flighttracker.config.SqliteDataSourceConfig;
import com.flighttracker.model.WatchedFlight;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.core.io.ClassPathResource;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.jdbc.datasource.init.ScriptUtils;

import javax.sql.DataSource;
import java.io.Closeable;
import java.nio.file.Path;
import java.sql.Connection;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/** The watched_flight table, mirroring the frontend's watchKey(w). */
class WatchedFlightRepositoryIntegrationTest {

    private static final Instant NOW = Instant.parse("2026-10-01T12:00:00Z");

    @TempDir
    Path tempDir;
    private DataSource dataSource;
    private JdbcClient jdbc;
    private WatchedFlightRepository repository;

    @BeforeEach
    void setUp() throws Exception {
        dataSource = SqliteDataSourceConfig.buildDataSource(tempDir.resolve("watched-repo.db").toString());
        jdbc = JdbcClient.create(dataSource);
        try (Connection c = dataSource.getConnection()) {
            ScriptUtils.executeSqlScript(c, new ClassPathResource("schema.sql"));
        }
        repository = new WatchedFlightRepository(jdbc, Clock.fixed(NOW, ZoneOffset.UTC));
    }

    @AfterEach
    void tearDown() throws Exception {
        if (dataSource instanceof Closeable c) c.close();
    }

    private List<String> datesFor(String profileId) {
        return repository.findByProfileId(profileId).stream().map(WatchedFlight::flightDate).toList();
    }

    @Test
    void upsert_thenRead_andListOrderedByBoardDate() {
        repository.upsert("p1", "SK123", "2026-10-02", "ESSA", "SAS 123");
        repository.upsert("p1", "SK100", "2026-10-01", "ESSA", null);

        WatchedFlight row = repository.find("p1", "SK123", "2026-10-02", "ESSA").orElseThrow();
        assertThat(row.label()).isEqualTo("SAS 123");
        assertThat(row.updatedAt()).isEqualTo(NOW);

        assertThat(datesFor("p1")).containsExactly("2026-10-01", "2026-10-02");
    }

    @Test
    void upsert_updatesTheLabel_andKeepsOneRow() {
        repository.upsert("p1", "SK123", "2026-10-02", "ESSA", "old");
        Instant later = NOW.plusSeconds(600);
        new WatchedFlightRepository(jdbc, Clock.fixed(later, ZoneOffset.UTC))
                .upsert("p1", "SK123", "2026-10-02", "ESSA", "new");

        assertThat(repository.findByProfileId("p1")).singleElement()
                .satisfies(w -> {
                    assertThat(w.label()).isEqualTo("new");
                    assertThat(w.updatedAt()).isEqualTo(later);
                });
    }

    @Test
    void sameFlightNumberOnTwoDatesOrAirports_areTwoRows() {
        repository.upsert("p1", "SK123", "2026-10-02", "ESSA", null);
        repository.upsert("p1", "SK123", "2026-10-03", "ESSA", null);
        repository.upsert("p1", "SK123", "2026-10-02", "ESGG", null);

        assertThat(repository.findByProfileId("p1")).hasSize(3);
    }

    @Test
    void delete_removesOne_andDeleteAllForProfile_removesTheRest() {
        repository.upsert("p1", "SK123", "2026-10-02", "ESSA", null);
        repository.upsert("p1", "SK124", "2026-10-02", "ESSA", null);
        repository.upsert("p2", "SK123", "2026-10-02", "ESSA", null);

        assertThat(repository.delete("p1", "SK123", "2026-10-02", "ESSA")).isEqualTo(1);
        assertThat(repository.deleteAllForProfile("p1")).isEqualTo(1);

        assertThat(repository.findByProfileId("p1")).isEmpty();
        assertThat(repository.findByProfileId("p2")).hasSize(1);
    }

    @Test
    void deleteBefore_prunesStrictlyOlderBoardDates_andKeepsTheBoundaryAndNewer() {
        repository.upsert("p1", "OLD", "2026-09-23", "ESSA", null);   // 9 days before cutoff
        repository.upsert("p1", "EDGE", "2026-09-24", "ESSA", null);  // the cutoff date itself
        repository.upsert("p1", "NEWER", "2026-10-01", "ESSA", null); // inside the window
        repository.upsert("p2", "OTHER", "2026-09-01", "ESGG", null); // another profile, same rule

        int deleted = repository.deleteBefore(LocalDate.parse("2026-09-24"));

        assertThat(deleted).isEqualTo(2); // OLD and p2's OTHER
        assertThat(repository.findByProfileId("p1")).extracting(WatchedFlight::flightNumber)
                .containsExactly("EDGE", "NEWER");
        assertThat(repository.findByProfileId("p2")).isEmpty();
    }
}
