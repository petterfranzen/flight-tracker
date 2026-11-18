package com.flighttracker.profile;

import com.flighttracker.config.SqliteDataSourceConfig;
import com.flighttracker.model.Profile;
import com.flighttracker.repository.ProfileRepository;
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
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.Base64;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Step 5a-1 (design section9-hq #84, §2): a completed login has to turn into a
 * profile exactly once. Against a real SQLite file with schema.sql run
 * unmodified (the ProfileRepositoryIntegrationTest pattern), this pins the four
 * things the resolver promises — first login creates one row, a second login
 * returns the same id, the same subject under two providers is two profiles,
 * and last_seen_at moves at most once a day.
 */
class ProfileResolverIntegrationTest {

    private static final Instant NOW = Instant.parse("2026-10-01T12:00:00Z");
    private static final String SUBJECT = "113702818845229001";

    @TempDir
    Path tempDir;
    private DataSource dataSource;
    private JdbcClient jdbc;

    @BeforeEach
    void setUp() throws Exception {
        dataSource = SqliteDataSourceConfig.buildDataSource(tempDir.resolve("profile-resolver.db").toString());
        jdbc = JdbcClient.create(dataSource);
        try (Connection c = dataSource.getConnection()) {
            ScriptUtils.executeSqlScript(c, new ClassPathResource("schema.sql"));
        }
    }

    @AfterEach
    void tearDown() throws Exception {
        if (dataSource instanceof Closeable c) c.close();
    }

    /** A resolver whose clock (and its repository's) is fixed at {@code now}. */
    private ProfileResolver resolverAt(Instant now) {
        Clock clock = Clock.fixed(now, ZoneOffset.UTC);
        return new ProfileResolver(new ProfileRepository(jdbc, clock), clock);
    }

    private long count() {
        return jdbc.sql("SELECT COUNT(*) FROM profile").query(Long.class).single();
    }

    private String storedGoogleSubjectHash() {
        return jdbc.sql("SELECT subject_hash FROM profile WHERE provider = 'google'")
                .query(String.class)
                .single();
    }

    @Test
    void firstLogin_createsOneRow_withA128BitId_andTheHashNotTheSubject() {
        Profile profile = resolverAt(NOW).resolve("google", SUBJECT);

        assertThat(count()).isEqualTo(1);
        assertThat(profile.provider()).isEqualTo("google");
        assertThat(profile.createdAt()).isEqualTo(NOW);
        assertThat(profile.lastSeenAt()).isEqualTo(NOW);

        // 128 bits, base64url: the decoded id is 16 bytes, and it is random,
        // never the subject.
        assertThat(Base64.getUrlDecoder().decode(profile.id())).hasSize(16);
        assertThat(profile.id()).isNotEqualTo(SUBJECT);
        assertThat(profile.subjectHash()).isEqualTo(SubjectHash.of("google", SUBJECT));

        // The raw subject is nowhere in the stored row — only the hash.
        String stored = storedGoogleSubjectHash();
        assertThat(stored).isEqualTo(profile.subjectHash());
        assertThat(stored).doesNotContain(SUBJECT).isNotEqualTo(SUBJECT);
    }

    @Test
    void aSecondLogin_returnsTheSameId_andInsertsNothing() {
        Profile first = resolverAt(NOW).resolve("google", SUBJECT);
        Profile second = resolverAt(NOW.plus(Duration.ofHours(3))).resolve("google", SUBJECT);

        assertThat(second.id()).isEqualTo(first.id());
        assertThat(second.createdAt()).isEqualTo(NOW);
        assertThat(count()).isEqualTo(1);
    }

    @Test
    void theSameSubjectUnderTwoProviders_isTwoProfiles() {
        Profile google = resolverAt(NOW).resolve("google", SUBJECT);
        Profile github = resolverAt(NOW).resolve("github", SUBJECT);

        assertThat(google.id()).isNotEqualTo(github.id());
        assertThat(google.subjectHash()).isNotEqualTo(github.subjectHash());
        assertThat(count()).isEqualTo(2);
    }

    @Test
    void lastSeenAt_movesAtMostOnceADay() {
        // Day one, at noon.
        assertThat(resolverAt(NOW).resolve("google", SUBJECT).lastSeenAt()).isEqualTo(NOW);

        // Later the same day — and at 23h — the row is read, not rewritten.
        assertThat(resolverAt(NOW.plus(Duration.ofHours(1))).resolve("google", SUBJECT).lastSeenAt())
                .isEqualTo(NOW);
        assertThat(resolverAt(NOW.plus(Duration.ofHours(23))).resolve("google", SUBJECT).lastSeenAt())
                .isEqualTo(NOW);

        // A day on, it moves once — created_at stays put.
        Instant dayTwo = NOW.plus(Duration.ofDays(1));
        Profile touched = resolverAt(dayTwo).resolve("google", SUBJECT);
        assertThat(touched.lastSeenAt()).isEqualTo(dayTwo);
        assertThat(touched.createdAt()).isEqualTo(NOW);

        // And then holds for another day, so a chatty client writes at most
        // once in any 24 h window.
        assertThat(resolverAt(dayTwo.plus(Duration.ofHours(23))).resolve("google", SUBJECT).lastSeenAt())
                .isEqualTo(dayTwo);

        assertThat(count()).isEqualTo(1);
    }

    @Test
    void twoDifferentSubjects_getTwoDifferentRandomIds() {
        Profile a = resolverAt(NOW).resolve("google", "subject-a");
        Profile b = resolverAt(NOW).resolve("google", "subject-b");

        assertThat(a.id()).isNotEqualTo(b.id());
        assertThat(count()).isEqualTo(2);
    }
}
