package com.flighttracker.repository;

import com.flighttracker.config.SqliteDataSourceConfig;
import com.flighttracker.model.Profile;
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

import static org.assertj.core.api.Assertions.assertThat;

/**
 * The profile table against a real SQLite file with schema.sql run unmodified,
 * the pattern LegDetectionIntegrationTest and the training tests use.
 */
class ProfileRepositoryIntegrationTest {

    private static final Instant NOW = Instant.parse("2026-10-01T12:00:00Z");

    @TempDir
    Path tempDir;
    private DataSource dataSource;
    private JdbcClient jdbc;
    private ProfileRepository repository;

    @BeforeEach
    void setUp() throws Exception {
        dataSource = SqliteDataSourceConfig.buildDataSource(tempDir.resolve("profile-repo.db").toString());
        jdbc = JdbcClient.create(dataSource);
        try (Connection c = dataSource.getConnection()) {
            ScriptUtils.executeSqlScript(c, new ClassPathResource("schema.sql"));
        }
        repository = new ProfileRepository(jdbc, Clock.fixed(NOW, ZoneOffset.UTC));
    }

    @AfterEach
    void tearDown() throws Exception {
        if (dataSource instanceof Closeable c) c.close();
    }

    private long count() {
        return jdbc.sql("SELECT COUNT(*) FROM profile").query(Long.class).single();
    }

    @Test
    void insert_stampsBothTimestampsFromTheClock_andReadsBack() {
        Profile inserted = repository.insertIfAbsent("id-1", "google", "hash-1").orElseThrow();

        assertThat(inserted.id()).isEqualTo("id-1");
        assertThat(inserted.provider()).isEqualTo("google");
        assertThat(inserted.subjectHash()).isEqualTo("hash-1");
        assertThat(inserted.createdAt()).isEqualTo(NOW);
        assertThat(inserted.lastSeenAt()).isEqualTo(NOW);

        assertThat(repository.findById("id-1")).contains(inserted);
        assertThat(repository.findByProviderAndSubjectHash("google", "hash-1")).contains(inserted);
    }

    @Test
    void insert_isIdempotent_onTheProviderSubjectIndex() {
        assertThat(repository.insertIfAbsent("id-1", "google", "hash-1")).isPresent();

        // A second sign-in for the same provider subject inserts nothing and
        // reports empty; the row (and its id) is untouched.
        assertThat(repository.insertIfAbsent("id-2", "google", "hash-1")).isEmpty();
        assertThat(count()).isEqualTo(1);
        assertThat(repository.findById("id-1")).isPresent();
        assertThat(repository.findById("id-2")).isEmpty();
    }

    @Test
    void theSameSubjectHashUnderAnotherProvider_isADifferentIdentity() {
        assertThat(repository.insertIfAbsent("id-1", "google", "hash-1")).isPresent();
        assertThat(repository.insertIfAbsent("id-2", "github", "hash-1")).isPresent();

        assertThat(count()).isEqualTo(2);
        assertThat(repository.findByProviderAndSubjectHash("github", "hash-1")).get()
                .extracting(Profile::id).isEqualTo("id-2");
    }

    @Test
    void touch_bumpsLastSeenOnly() {
        repository.insertIfAbsent("id-1", "google", "hash-1");
        Instant later = NOW.plusSeconds(3600);
        new ProfileRepository(jdbc, Clock.fixed(later, ZoneOffset.UTC)).touch("id-1");

        Profile after = repository.findById("id-1").orElseThrow();
        assertThat(after.lastSeenAt()).isEqualTo(later);
        assertThat(after.createdAt()).isEqualTo(NOW);
    }

    @Test
    void deleteById_reportsWhetherARowWent() {
        repository.insertIfAbsent("id-1", "google", "hash-1");

        assertThat(repository.deleteById("id-1")).isEqualTo(1);
        assertThat(repository.deleteById("id-1")).isZero();
        assertThat(count()).isZero();
    }

    @Test
    void unknownId_findsNothing() {
        assertThat(repository.findById("nope")).isEmpty();
        assertThat(repository.findByProviderAndSubjectHash("google", "nope")).isEmpty();
    }
}
