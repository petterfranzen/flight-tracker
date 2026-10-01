package com.flighttracker.repository;

import com.flighttracker.config.SqliteDataSourceConfig;
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

import static org.assertj.core.api.Assertions.assertThat;

/**
 * findCurrentLegTakeoffTime against the real schema. The case that
 * motivated the callsign/gap rules: an aircraft that flew ARN->AMS, turned
 * around without any on_ground report reaching us, and left AMS under a
 * new flight number — those used to read as one leg.
 */
class LegDetectionIntegrationTest {

    private static final String ICAO = "48415e";
    private static final Instant T0 = Instant.parse("2026-10-01T06:00:00Z");

    @TempDir
    Path tempDir;
    private DataSource dataSource;
    private JdbcClient jdbc;
    private FlightPositionRepository repository;

    @BeforeEach
    void setUp() throws Exception {
        dataSource = SqliteDataSourceConfig.buildDataSource(tempDir.resolve("legs.db").toString());
        jdbc = JdbcClient.create(dataSource);
        try (Connection connection = dataSource.getConnection()) {
            ScriptUtils.executeSqlScript(connection, new ClassPathResource("schema.sql"));
        }
        repository = new FlightPositionRepository(jdbc, Clock.fixed(T0, ZoneOffset.UTC));
        jdbc.sql("INSERT INTO aircraft (icao24, first_seen_at, last_seen_at) VALUES (:i, 0, 0)").param("i", ICAO).update();
    }

    @AfterEach
    void tearDown() throws Exception {
        if (dataSource instanceof Closeable c) c.close();
    }

    private void report(int minute, String callsign, double altitudeM, boolean onGround) {
        jdbc.sql("""
                INSERT INTO flight_position (icao24, callsign, observed_at, latitude, longitude, altitude_m,
                                             on_ground, agent_source, inserted_at)
                VALUES (:i, :c, :t, 55, 10, :alt, :g, 'opensky', 0)
                """)
                .param("i", ICAO).param("c", callsign)
                .param("t", T0.plus(Duration.ofMinutes(minute)).toEpochMilli())
                .param("alt", altitudeM).param("g", onGround ? 1 : 0)
                .update();
    }

    private Instant at(int minute) {
        return T0.plus(Duration.ofMinutes(minute));
    }

    @Test
    void groundToAirTransitionStartsALeg() {
        report(0, "KLM45M", 11000, false);
        report(60, "KLM45M", 0, true);
        report(100, "KLM45M", 300, false);
        report(110, "KLM45M", 5000, false);
        assertThat(repository.findCurrentLegTakeoffTime(ICAO)).contains(at(100));
    }

    @Test
    void callsignChangeStartsALegEvenWithNoGroundReport() {
        report(0, "KLM1112", 11000, false);
        report(6, "KLM1112", 2500, false);
        report(12, "KLM46M", 2000, false); // turnaround we never saw on the ground
        report(18, "KLM46M", 9000, false);
        assertThat(repository.findCurrentLegTakeoffTime(ICAO)).contains(at(12));
    }

    @Test
    void callsignComparisonIgnoresPaddingAndCase() {
        report(0, "KLM46M  ", 9000, false);
        report(6, "klm46m", 9000, false);
        assertThat(repository.findCurrentLegTakeoffTime(ICAO)).contains(at(0));
    }

    @Test
    void longSilenceAfterLowAltitudeStartsALeg() {
        report(0, null, 11000, false);
        report(30, null, 1200, false);  // on approach, then silence
        report(85, null, 1500, false);  // climbing out again
        report(91, null, 6000, false);
        assertThat(repository.findCurrentLegTakeoffTime(ICAO)).contains(at(85));
    }

    @Test
    void longSilenceAtCruiseDoesNotSplitTheLeg() {
        report(0, "DAL15", 400, false);
        report(10, "DAL15", 11000, false);
        report(190, "DAL15", 11000, false); // ocean crossing out of receiver range
        assertThat(repository.findCurrentLegTakeoffTime(ICAO)).contains(at(0));
    }

    @Test
    void missingCallsignOnOneSideIsNotAChange() {
        report(0, "SAS100", 9000, false);
        report(6, null, 9000, false);
        report(12, "SAS100", 9000, false);
        assertThat(repository.findCurrentLegTakeoffTime(ICAO)).contains(at(0));
    }
}
