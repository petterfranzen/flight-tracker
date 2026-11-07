package com.flighttracker.profile;

import com.flighttracker.config.SqliteDataSourceConfig;
import com.flighttracker.profile.ProfileLimitException.Reason;
import com.flighttracker.repository.FavoriteRepository;
import com.flighttracker.repository.WatchedFlightRepository;
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

import static com.flighttracker.profile.ProfileLimits.*;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** Size, count and format caps on favorite and watched_flight, enforced where the rows are written. */
class ProfileLimitsIntegrationTest {

    @TempDir
    Path tempDir;
    private DataSource dataSource;
    private FavoriteRepository favorites;
    private WatchedFlightRepository watched;

    @BeforeEach
    void setUp() throws Exception {
        dataSource = SqliteDataSourceConfig.buildDataSource(tempDir.resolve("limits.db").toString());
        try (Connection c = dataSource.getConnection()) {
            ScriptUtils.executeSqlScript(c, new ClassPathResource("schema.sql"));
        }
        JdbcClient jdbc = JdbcClient.create(dataSource);
        Clock clock = Clock.fixed(Instant.parse("2026-10-01T12:00:00Z"), ZoneOffset.UTC);
        favorites = new FavoriteRepository(jdbc, clock);
        watched = new WatchedFlightRepository(jdbc, clock);
    }

    @AfterEach
    void tearDown() throws Exception {
        if (dataSource instanceof Closeable c) c.close();
    }

    private static String jsonOfBytes(int bytes) {
        // {"a":"xxx"} is 8 bytes of framing around the filler
        return "{\"a\":\"" + "x".repeat(bytes - 8) + "\"}";
    }

    private void assertRejected(Runnable r, Reason reason, String field) {
        assertThatThrownBy(r::run).isInstanceOfSatisfying(ProfileLimitException.class, e -> {
            assertThat(e.reason()).isEqualTo(reason);
            assertThat(e.field()).isEqualTo(field);
        });
    }

    // ---- favorite.data and keys

    @Test
    void favoriteData_atCapPasses_oneOverFails() {
        favorites.upsert("p1", "route", "a", jsonOfBytes(MAX_FAVORITE_DATA_BYTES));
        assertThat(favorites.find("p1", "route", "a")).isPresent();

        assertRejected(() -> favorites.upsert("p1", "route", "b", jsonOfBytes(MAX_FAVORITE_DATA_BYTES + 1)),
                Reason.TOO_LONG, "data");
        assertThat(favorites.find("p1", "route", "b")).isEmpty();
    }

    @Test
    void favoriteData_capCountsUtf8Bytes_notChars() {
        // 'å' is 2 bytes: fits by char count, exceeds by bytes
        String data = "{\"a\":\"" + "å".repeat(MAX_FAVORITE_DATA_BYTES / 2) + "\"}";
        assertRejected(() -> favorites.upsert("p1", "route", "a", data), Reason.TOO_LONG, "data");
    }

    @Test
    void favoriteData_mustBeValidJson() {
        for (String bad : new String[]{"not json", "{\"a\":", "{} trailing", ""}) {
            assertRejected(() -> favorites.upsert("p1", "route", "a", bad), Reason.INVALID, "data");
        }
        assertRejected(() -> favorites.upsert("p1", "route", "a", null), Reason.INVALID, "data");
        assertThat(favorites.countForProfile("p1")).isZero();
    }

    @Test
    void favoriteKindAndItemKey_areChecked() {
        assertRejected(() -> favorites.upsert("p1", "hotel", "a", "{}"), Reason.INVALID, "kind");
        assertRejected(() -> favorites.upsert("p1", "route", " ", "{}"), Reason.INVALID, "itemKey");
        favorites.upsert("p1", "route", "k".repeat(MAX_ITEM_KEY_LENGTH), "{}");
        assertRejected(() -> favorites.upsert("p1", "route", "k".repeat(MAX_ITEM_KEY_LENGTH + 1), "{}"),
                Reason.TOO_LONG, "itemKey");
    }

    // ---- favorite row count

    @Test
    void favoriteRows_capHoldsOnTheNextInsert_andWritesNothing() {
        for (int i = 0; i < MAX_FAVORITES_PER_PROFILE; i++) {
            favorites.upsert("p1", "aircraft", "k" + i, "{\"n\":" + i + "}");
        }
        assertRejected(() -> favorites.upsert("p1", "aircraft", "extra", "{}"), Reason.TOO_MANY_ROWS, "favorites");
        assertRejected(() -> favorites.upsert("p1", "route", "k0", "{}"), Reason.TOO_MANY_ROWS, "favorites"); // new kind+key
        assertThat(favorites.countForProfile("p1")).isEqualTo(MAX_FAVORITES_PER_PROFILE);
        assertThat(favorites.find("p1", "aircraft", "extra")).isEmpty();
        assertThat(favorites.find("p1", "aircraft", "k0").orElseThrow().data()).isEqualTo("{\"n\":0}");
    }

    @Test
    void favoriteRows_upsertOfExistingKeyAtTheCapStillWorks_andOtherProfilesAreUnaffected() {
        for (int i = 0; i < MAX_FAVORITES_PER_PROFILE; i++) {
            favorites.upsert("p1", "aircraft", "k" + i, "{}");
        }
        favorites.upsert("p1", "aircraft", "k7", "{\"changed\":true}");
        assertThat(favorites.find("p1", "aircraft", "k7").orElseThrow().data()).isEqualTo("{\"changed\":true}");
        assertThat(favorites.countForProfile("p1")).isEqualTo(MAX_FAVORITES_PER_PROFILE);

        favorites.upsert("p2", "aircraft", "k0", "{}");
        assertThat(favorites.countForProfile("p2")).isEqualTo(1);

        favorites.delete("p1", "aircraft", "k0");
        assertThatCode(() -> favorites.upsert("p1", "aircraft", "fresh", "{}")).doesNotThrowAnyException();
    }

    // ---- watched_flight

    @Test
    void watchedLabel_atCapPasses_oneOverFails_nullAllowed() {
        watched.upsert("p1", "SK1", "2026-10-02", "ESSA", "x".repeat(MAX_LABEL_LENGTH));
        watched.upsert("p1", "SK2", "2026-10-02", "ESSA", null);
        assertRejected(() -> watched.upsert("p1", "SK3", "2026-10-02", "ESSA", "x".repeat(MAX_LABEL_LENGTH + 1)),
                Reason.TOO_LONG, "label");
        assertThat(watched.find("p1", "SK3", "2026-10-02", "ESSA")).isEmpty();
        // an over-long label on an existing row must not truncate or replace it
        assertRejected(() -> watched.upsert("p1", "SK1", "2026-10-02", "ESSA", "y".repeat(MAX_LABEL_LENGTH + 1)),
                Reason.TOO_LONG, "label");
        assertThat(watched.find("p1", "SK1", "2026-10-02", "ESSA").orElseThrow().label())
                .isEqualTo("x".repeat(MAX_LABEL_LENGTH));
    }

    @Test
    void watchedKeyLengths_atCapPass_oneOverFails() {
        watched.upsert("p1", "F".repeat(MAX_FLIGHT_NUMBER_LENGTH), "2026-10-02", "A".repeat(MAX_AIRPORT_LENGTH), null);
        assertRejected(() -> watched.upsert("p1", "F".repeat(MAX_FLIGHT_NUMBER_LENGTH + 1), "2026-10-02", "ESSA", null),
                Reason.TOO_LONG, "flightNumber");
        assertRejected(() -> watched.upsert("p1", "SK1", "2026-10-02", "A".repeat(MAX_AIRPORT_LENGTH + 1), null),
                Reason.TOO_LONG, "airport");
        assertRejected(() -> watched.upsert("p1", "", "2026-10-02", "ESSA", null), Reason.INVALID, "flightNumber");
        assertThat(watched.findByProfileId("p1")).hasSize(1);
    }

    @Test
    void flightDate_mustBeARealYyyyMmDd() {
        for (String bad : new String[]{"2026-13-01", "2026-02-30", "2026-1-5", "20261002", "2026/10/02",
                "2026-10-02T00:00", " 2026-10-02", "", null}) {
            assertRejected(() -> watched.upsert("p1", "SK1", bad, "ESSA", null), Reason.INVALID, "flightDate");
        }
        watched.upsert("p1", "SK1", "2028-02-29", "ESSA", null); // leap day
        assertThat(watched.findByProfileId("p1")).hasSize(1);
    }

    @Test
    void watchedRows_capHoldsOnTheNextInsert_andExistingKeyStillUpserts() {
        for (int i = 0; i < MAX_WATCHED_FLIGHTS_PER_PROFILE; i++) {
            watched.upsert("p1", "SK" + i, "2026-10-02", "ESSA", "l" + i);
        }
        assertRejected(() -> watched.upsert("p1", "SKX", "2026-10-02", "ESSA", null),
                Reason.TOO_MANY_ROWS, "watchedFlights");
        assertThat(watched.findByProfileId("p1")).hasSize(MAX_WATCHED_FLIGHTS_PER_PROFILE);
        assertThat(watched.find("p1", "SKX", "2026-10-02", "ESSA")).isEmpty();

        watched.upsert("p1", "SK3", "2026-10-02", "ESSA", "renamed");
        assertThat(watched.find("p1", "SK3", "2026-10-02", "ESSA").orElseThrow().label()).isEqualTo("renamed");
        assertThat(watched.findByProfileId("p1")).hasSize(MAX_WATCHED_FLIGHTS_PER_PROFILE);

        watched.upsert("p2", "SKX", "2026-10-02", "ESSA", null); // other profile unaffected
        assertThat(watched.findByProfileId("p2")).hasSize(1);
    }
}
