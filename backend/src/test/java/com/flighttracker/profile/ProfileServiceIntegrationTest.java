package com.flighttracker.profile;

import com.flighttracker.config.SqliteDataSourceConfig;
import com.flighttracker.repository.FavoriteRepository;
import com.flighttracker.repository.ProfileRepository;
import com.flighttracker.repository.WatchedFlightRepository;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.core.io.ClassPathResource;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.init.ScriptUtils;
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
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * The explicit, transactional account delete (design §2): the children are
 * deleted by hand before the profile, in one transaction, because SQLite does
 * not enforce the ON DELETE CASCADE that the design deliberately does not rely
 * on. This proves both halves — the delete removes every row, and a failure
 * anywhere in it rolls the whole thing back rather than leaving half an account.
 */
class ProfileServiceIntegrationTest {

    private static final Instant NOW = Instant.parse("2026-10-01T12:00:00Z");

    @TempDir
    Path tempDir;
    private DataSource dataSource;
    private JdbcClient jdbc;
    private ProfileRepository profiles;
    private FavoriteRepository favorites;
    private WatchedFlightRepository watched;

    @BeforeEach
    void setUp() throws Exception {
        dataSource = SqliteDataSourceConfig.buildDataSource(tempDir.resolve("profile-service.db").toString());
        jdbc = JdbcClient.create(dataSource);
        try (Connection c = dataSource.getConnection()) {
            ScriptUtils.executeSqlScript(c, new ClassPathResource("schema.sql"));
        }
        Clock clock = Clock.fixed(NOW, ZoneOffset.UTC);
        profiles = new ProfileRepository(jdbc, clock);
        favorites = new FavoriteRepository(jdbc, clock);
        watched = new WatchedFlightRepository(jdbc, clock);
    }

    @AfterEach
    void tearDown() throws Exception {
        if (dataSource instanceof Closeable c) c.close();
    }

    private ProfileService service() {
        return new ProfileService(profiles, favorites, watched,
                new TransactionTemplate(new DataSourceTransactionManager(dataSource)));
    }

    private ProfileService service(ProfileRepository profilesOverride) {
        return new ProfileService(profilesOverride, favorites, watched,
                new TransactionTemplate(new DataSourceTransactionManager(dataSource)));
    }

    private void seed(String profileId) {
        profiles.insertIfAbsent(profileId, "google", "hash-" + profileId);
        favorites.upsert(profileId, "route", "ESSA-ESGG", "{}");
        favorites.upsert(profileId, "aircraft", "48415e", "{}");
        watched.upsert(profileId, "SK123", "2026-10-02", "ESSA", null);
    }

    private long count(String table) {
        return jdbc.sql("SELECT COUNT(*) FROM " + table).query(Long.class).single();
    }

    /** Row counts of profile, favorite and watched_flight, in that order. */
    private List<Long> rowCounts() {
        return List.of(count("profile"), count("favorite"), count("watched_flight"));
    }

    @Test
    void deleteProfile_erasesTheProfileAndEveryChildRow() {
        seed("p1");

        assertThat(service().deleteProfile("p1")).isTrue();

        assertThat(rowCounts()).containsExactly(0L, 0L, 0L);
    }

    @Test
    void deleteProfile_leavesAnotherProfileUntouched() {
        seed("p1");
        seed("p2");

        assertThat(service().deleteProfile("p1")).isTrue();

        assertThat(count("profile")).isEqualTo(1);
        assertThat(List.of(favorites.countForProfile("p2"), (long) watched.findByProfileId("p2").size()))
                .as("p2's favorites and watched flights").containsExactly(2L, 1L);
    }

    @Test
    void deletingAProfileThatIsNotThere_reportsFalse_andChangesNothing() {
        seed("p1");

        assertThat(service().deleteProfile("missing")).isFalse();

        assertThat(rowCounts()).containsExactly(1L, 2L, 1L);
    }

    @Test
    void aFailureAtTheLastStep_rollsBackTheChildDeletesToo() {
        seed("p1");

        // The profile delete is the last step; if it throws, the favorites and
        // watched rows already deleted inside the same transaction must come back.
        ProfileRepository failing = new ProfileRepository(jdbc, Clock.fixed(NOW, ZoneOffset.UTC)) {
            @Override
            public int deleteById(String id) {
                throw new RuntimeException("boom");
            }
        };

        assertThatThrownBy(() -> service(failing).deleteProfile("p1"))
                .isInstanceOf(RuntimeException.class);

        assertThat(rowCounts()).containsExactly(1L, 2L, 1L);
    }
}
