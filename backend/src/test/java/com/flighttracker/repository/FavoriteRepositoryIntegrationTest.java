package com.flighttracker.repository;

import com.flighttracker.config.SqliteDataSourceConfig;
import com.flighttracker.model.Favorite;
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
import java.time.ZoneOffset;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/** The favorite table, keyed (profile_id, kind, item_key) the way the frontend keys a favourite. */
class FavoriteRepositoryIntegrationTest {

    private static final Instant NOW = Instant.parse("2026-10-01T12:00:00Z");

    @TempDir
    Path tempDir;
    private DataSource dataSource;
    private JdbcClient jdbc;
    private FavoriteRepository repository;

    @BeforeEach
    void setUp() throws Exception {
        dataSource = SqliteDataSourceConfig.buildDataSource(tempDir.resolve("favorite-repo.db").toString());
        jdbc = JdbcClient.create(dataSource);
        try (Connection c = dataSource.getConnection()) {
            ScriptUtils.executeSqlScript(c, new ClassPathResource("schema.sql"));
        }
        repository = new FavoriteRepository(jdbc, Clock.fixed(NOW, ZoneOffset.UTC));
    }

    @AfterEach
    void tearDown() throws Exception {
        if (dataSource instanceof Closeable c) c.close();
    }

    @Test
    void upsert_thenRead_andListForTheProfile() {
        repository.upsert("p1", "route", "ESSA-ESGG", "{\"origin\":\"ESSA\"}");
        repository.upsert("p1", "aircraft", "48415e", "{\"icao24\":\"48415e\"}");

        Favorite route = repository.find("p1", "route", "ESSA-ESGG").orElseThrow();
        assertThat(route.data()).isEqualTo("{\"origin\":\"ESSA\"}");
        assertThat(route.updatedAt()).isEqualTo(NOW);

        assertThat(repository.findByProfileId("p1")).extracting(Favorite::itemKey)
                .containsExactly("48415e", "ESSA-ESGG"); // ordered by kind, item_key
        assertThat(repository.countForProfile("p1")).isEqualTo(2);
    }

    @Test
    void upsert_replacesTheDataAndStampsANewerUpdatedAt() {
        repository.upsert("p1", "route", "ESSA-ESGG", "old");
        Instant later = NOW.plusSeconds(600);
        new FavoriteRepository(jdbc, Clock.fixed(later, ZoneOffset.UTC))
                .upsert("p1", "route", "ESSA-ESGG", "new");

        Favorite after = repository.find("p1", "route", "ESSA-ESGG").orElseThrow();
        assertThat(after.data()).isEqualTo("new");
        assertThat(after.updatedAt()).isEqualTo(later);
        assertThat(repository.countForProfile("p1")).isEqualTo(1);
    }

    @Test
    void theSameItemKey_underTwoKindsIsTwoRows() {
        repository.upsert("p1", "route", "X", "r");
        repository.upsert("p1", "aircraft", "X", "a");

        assertThat(repository.countForProfile("p1")).isEqualTo(2);
        assertThat(repository.find("p1", "route", "X")).get().extracting(Favorite::data).isEqualTo("r");
        assertThat(repository.find("p1", "aircraft", "X")).get().extracting(Favorite::data).isEqualTo("a");
    }

    @Test
    void favoritesAreScopedToTheirProfile() {
        repository.upsert("p1", "route", "X", "r");
        repository.upsert("p2", "route", "X", "r");

        assertThat(repository.findByProfileId("p1")).hasSize(1);
        assertThat(repository.countForProfile("p2")).isEqualTo(1);
    }

    @Test
    void delete_removesOne_andDeleteAllForProfile_removesTheRest() {
        repository.upsert("p1", "route", "X", "r");
        repository.upsert("p1", "route", "Y", "r");
        repository.upsert("p2", "route", "X", "r");

        assertThat(repository.delete("p1", "route", "X")).isEqualTo(1);
        assertThat(repository.delete("p1", "route", "X")).isZero();
        assertThat(repository.deleteAllForProfile("p1")).isEqualTo(1);

        assertThat(repository.findByProfileId("p1")).isEmpty();
        assertThat(repository.countForProfile("p2")).isEqualTo(1);
    }
}
