package com.flighttracker.repository;

import com.flighttracker.config.SqliteDataSourceConfig;
import com.flighttracker.model.FlightPosition;
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
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * The two per-aircraft time-window reads on flight_position, against the real
 * SQLite schema: findByIcao24AndObservedAtBetween (track history for
 * FlightController and EstimatorAgent) and findAltitudeAtOrBefore (the
 * dossier's altitude trend). Both bounds of each window are inclusive.
 */
class FlightPositionWindowQueriesIntegrationTest {

    private static final String ICAO = "4ac9e5";
    private static final String OTHER_ICAO = "48415e";
    private static final Instant T0 = Instant.parse("2026-10-01T06:00:00Z");

    @TempDir
    Path tempDir;
    private DataSource dataSource;
    private FlightPositionRepository repository;

    @BeforeEach
    void setUp() throws Exception {
        dataSource = SqliteDataSourceConfig.buildDataSource(tempDir.resolve("window.db").toString());
        JdbcClient jdbc = JdbcClient.create(dataSource);
        try (Connection connection = dataSource.getConnection()) {
            ScriptUtils.executeSqlScript(connection, new ClassPathResource("schema.sql"));
        }
        repository = new FlightPositionRepository(jdbc, Clock.fixed(T0, ZoneOffset.UTC));
        for (String icao : List.of(ICAO, OTHER_ICAO)) {
            jdbc.sql("INSERT INTO aircraft (icao24, first_seen_at, last_seen_at) VALUES (:i, 0, 0)")
                    .param("i", icao).update();
        }
    }

    @AfterEach
    void tearDown() throws Exception {
        if (dataSource instanceof Closeable closeable) closeable.close();
    }

    private static Instant at(int minute) {
        return T0.plus(Duration.ofMinutes(minute));
    }

    private void report(String icao, int minute, Double altitudeM, boolean onGround) {
        repository.insertIgnoringDuplicate(icao, "SAS1234", at(minute), 59.6, 17.9, altitudeM,
                230.0, 90.0, 0.0, onGround, "opensky");
    }

    private void report(int minute, Double altitudeM) {
        report(ICAO, minute, altitudeM, false);
    }

    private static List<Instant> times(List<FlightPosition> positions) {
        return positions.stream().map(FlightPosition::observedAt).toList();
    }

    @Test
    void trackWindow_includesBothBoundsAndExcludesRowsJustOutside() {
        report(9, 1000.0);
        report(10, 2000.0);
        report(15, 3000.0);
        report(20, 4000.0);
        report(21, 5000.0);

        List<FlightPosition> track = repository.findByIcao24AndObservedAtBetween(ICAO, at(10), at(20));

        assertThat(times(track)).containsExactly(at(10), at(15), at(20));
    }

    @Test
    void trackWindow_isOneMillisecondPrecise() {
        report(10, 2000.0);

        assertThat(repository.findByIcao24AndObservedAtBetween(ICAO, at(10).plusMillis(1), at(20))).isEmpty();
        assertThat(repository.findByIcao24AndObservedAtBetween(ICAO, at(0), at(10).minusMillis(1))).isEmpty();
    }

    @Test
    void trackWindow_isOrderedOldestFirstWhateverTheInsertOrder() {
        report(30, 3000.0);
        report(10, 1000.0);
        report(20, 2000.0);

        assertThat(times(repository.findByIcao24AndObservedAtBetween(ICAO, at(0), at(60))))
                .containsExactly(at(10), at(20), at(30));
    }

    @Test
    void trackWindow_returnsOnlyTheRequestedAircraft() {
        report(10, 1000.0);
        report(OTHER_ICAO, 11, 1000.0, false);

        assertThat(repository.findByIcao24AndObservedAtBetween(ICAO, at(0), at(60)))
                .extracting(FlightPosition::icao24).containsExactly(ICAO);
        assertThat(repository.findByIcao24AndObservedAtBetween(ICAO.toUpperCase(), at(0), at(60))).isEmpty();
    }

    @Test
    void trackWindow_mapsEveryColumnIncludingNulls() {
        repository.insertIgnoringDuplicate(ICAO, "SAS1234", at(10), 59.6, 17.9, null,
                null, null, null, true, "opensky");

        FlightPosition row = repository.findByIcao24AndObservedAtBetween(ICAO, at(10), at(10)).get(0);

        assertThat(row.id()).isNotNull();
        assertThat(row).usingRecursiveComparison().ignoringFields("id").isEqualTo(new FlightPosition(
                null, ICAO, "SAS1234", at(10), 59.6, 17.9, null, null, null, null, true, "opensky"));
    }

    @Test
    void trackWindow_withFromAfterTo_isEmpty() {
        report(10, 1000.0);

        assertThat(repository.findByIcao24AndObservedAtBetween(ICAO, at(20), at(0))).isEmpty();
    }

    @Test
    void altitudeAtOrBefore_returnsTheLatestReportAtOrBeforeTheReferenceTime() {
        report(10, 1000.0);
        report(20, 2000.0);
        report(30, 3000.0);

        assertThat(repository.findAltitudeAtOrBefore(ICAO, at(0), at(25))).contains(2000.0);
        assertThat(repository.findAltitudeAtOrBefore(ICAO, at(0), at(20))).contains(2000.0);
        assertThat(repository.findAltitudeAtOrBefore(ICAO, at(0), at(20).minusMillis(1))).contains(1000.0);
    }

    @Test
    void altitudeAtOrBefore_includesARowExactlyAtLegStartButNothingEarlier() {
        report(9, 900.0);
        report(10, 1000.0);

        assertThat(repository.findAltitudeAtOrBefore(ICAO, at(10), at(15))).contains(1000.0);
        assertThat(repository.findAltitudeAtOrBefore(ICAO, at(10).plusMillis(1), at(15))).isEmpty();
    }

    @Test
    void altitudeAtOrBefore_ignoresOtherAircraftAndCountsGroundReports() {
        report(OTHER_ICAO, 12, 9000.0, false);
        report(ICAO, 11, 0.0, true);

        assertThat(repository.findAltitudeAtOrBefore(ICAO, at(0), at(15))).contains(0.0);
    }

    @Test
    void altitudeAtOrBefore_latestRowWithNullAltitude_isEmptyRatherThanAnOlderValue() {
        report(10, 1000.0);
        report(20, null);

        assertThat(repository.findAltitudeAtOrBefore(ICAO, at(0), at(25))).isEmpty();
    }

    @Test
    void altitudeAtOrBefore_withNoRowInTheWindow_isEmpty() {
        report(30, 3000.0);

        assertThat(repository.findAltitudeAtOrBefore(ICAO, at(0), at(25))).isEmpty();
    }
}
