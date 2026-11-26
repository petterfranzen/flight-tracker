package com.flighttracker.service;

import com.flighttracker.config.SqliteDataSourceConfig;
import com.flighttracker.dto.AircraftUsage;
import com.flighttracker.repository.AircraftRepository;
import com.flighttracker.repository.FlightPositionRepository;
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
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * The streamed usage totals against the list-based computation they
 * replaced, on a seeded dataset in the real schema. {@link Reference} is
 * that earlier computation, kept here only as the oracle.
 */
class UsageServiceTest {

    private static final Instant T0 = Instant.parse("2026-11-18T00:00:00Z");
    private static final int AIRCRAFT = 25;

    @TempDir
    Path tempDir;
    private DataSource dataSource;
    private JdbcClient jdbc;
    private UsageService service;

    @BeforeEach
    void setUp() throws Exception {
        dataSource = SqliteDataSourceConfig.buildDataSource(tempDir.resolve("usage.db").toString());
        jdbc = JdbcClient.create(dataSource);
        try (Connection connection = dataSource.getConnection()) {
            ScriptUtils.executeSqlScript(connection, new ClassPathResource("schema.sql"));
        }
        Clock clock = Clock.fixed(T0, ZoneOffset.UTC);
        service = new UsageService(new FlightPositionRepository(jdbc, clock), new AircraftRepository(jdbc, clock));
        seed(new Random(20261119L));
    }

    @AfterEach
    void tearDown() throws Exception {
        if (dataSource instanceof Closeable c) c.close();
    }

    /** ~30 h of interleaved tracks: ground and airborne runs, gaps, a duplicate tick from a second source. */
    private void seed(Random random) {
        for (int a = 0; a < AIRCRAFT; a++) {
            String icao24 = String.format("4a%04x", a * 37);
            String registration = a % 3 == 0 ? null : "SE-" + (char) ('A' + a % 26) + "BC";
            jdbc.sql("INSERT INTO aircraft (icao24, registration, first_seen_at, last_seen_at) VALUES (:i, :r, 0, 0)")
                    .param("i", icao24).param("r", registration).update();
            seedTrack(random, icao24);
        }
    }

    private void seedTrack(Random random, String icao24) {
        long t = T0.toEpochMilli() + random.nextInt(3_600_000);
        double lat = 50 + random.nextDouble() * 15;
        double lon = random.nextDouble() * 25;
        boolean onGround = random.nextBoolean();
        while (t < T0.plus(Duration.ofHours(30)).toEpochMilli()) {
            insert(icao24, t, lat, lon, onGround, "opensky");
            if (random.nextInt(40) == 0) insert(icao24, t, lat + 0.01, lon, onGround, "adsblol");
            if (random.nextInt(25) == 0) onGround = !onGround;
            lat += (random.nextDouble() - 0.5) * 0.4;
            lon += (random.nextDouble() - 0.5) * 0.4;
            t += 5_000 + random.nextInt(random.nextInt(50) == 0 ? 7_200_000 : 600_000);
        }
    }

    private void insert(String icao24, long t, double lat, double lon, boolean onGround, String source) {
        jdbc.sql("""
                INSERT INTO flight_position (icao24, callsign, observed_at, latitude, longitude,
                                             on_ground, agent_source, inserted_at)
                VALUES (:i, 'TST1', :t, :lat, :lon, :g, :s, 0)
                """)
                .param("i", icao24).param("t", t).param("lat", lat).param("lon", lon)
                .param("g", onGround ? 1 : 0).param("s", source)
                .update();
    }

    private void assertMatchesReference(Instant from, Instant to) {
        List<AircraftUsage> expected = new Reference(jdbc).usageForWindow(from, to);
        assertThat(service.usageForWindow(from, to)).isEqualTo(expected);
    }

    @Test
    void matchesTheListComputationOverFull24HourWindows() {
        for (int startHour = 0; startHour <= 6; startHour += 3) {
            Instant from = T0.plus(Duration.ofHours(startHour));
            assertMatchesReference(from, from.plus(Duration.ofHours(24)));
        }
        assertThat(new Reference(jdbc).usageForWindow(T0, T0.plus(Duration.ofHours(24)))).hasSize(AIRCRAFT);
    }

    @Test
    void matchesTheListComputationOverShortAndOddWindows() {
        assertMatchesReference(T0.plus(Duration.ofMinutes(90)), T0.plus(Duration.ofMinutes(150)));
        assertMatchesReference(T0.plusMillis(12_345), T0.plus(Duration.ofHours(7)).plusMillis(678));
        assertMatchesReference(T0.plus(Duration.ofHours(29)), T0.plus(Duration.ofHours(31)));
    }

    @Test
    void anEmptyWindowIsAnEmptyReport() {
        Instant before = T0.minus(Duration.ofDays(2));
        assertThat(service.usageForWindow(before, before.plus(Duration.ofHours(1)))).isEmpty();
    }

    @Test
    void fixedTrackGivesKnownTotals() {
        Instant from = T0.minus(Duration.ofDays(3));
        String icao24 = "ffffff";
        jdbc.sql("INSERT INTO aircraft (icao24, registration, first_seen_at, last_seen_at) VALUES (:i, 'SE-XYZ', 0, 0)")
                .param("i", icao24).update();
        // One degree of latitude due north per leg (~111.19 km), the middle leg airborne for an hour.
        insert(icao24, from.toEpochMilli(), 59, 18, true, "opensky");
        insert(icao24, from.plus(Duration.ofMinutes(30)).toEpochMilli(), 60, 18, false, "opensky");
        insert(icao24, from.plus(Duration.ofMinutes(90)).toEpochMilli(), 61, 18, false, "opensky");
        insert(icao24, from.plus(Duration.ofMinutes(120)).toEpochMilli(), 62, 18, true, "opensky");

        assertThat(service.usageForWindow(from, from.plus(Duration.ofHours(3))))
                .containsExactly(new AircraftUsage(icao24, "SE-XYZ", 4, 333.58, 1.0, 333.58));
    }

    /** The list-based computation UsageService used before it streamed. Test oracle only. */
    private record Reference(JdbcClient jdbc) {

        private record Row(String icao24, Instant observedAt, double latitude, double longitude, boolean onGround) { }

        List<AircraftUsage> usageForWindow(Instant from, Instant to) {
            List<Row> all = jdbc.sql("""
                    SELECT * FROM flight_position
                    WHERE observed_at BETWEEN :from AND :to
                    ORDER BY icao24 ASC, observed_at ASC
                    """)
                    .param("from", from.toEpochMilli()).param("to", to.toEpochMilli())
                    .query((rs, n) -> new Row(rs.getString("icao24"), Instant.ofEpochMilli(rs.getLong("observed_at")),
                            rs.getDouble("latitude"), rs.getDouble("longitude"), rs.getInt("on_ground") != 0))
                    .list();
            Map<String, List<Row>> byAircraft = new LinkedHashMap<>();
            for (Row row : all) byAircraft.computeIfAbsent(row.icao24(), k -> new ArrayList<>()).add(row);
            return byAircraft.entrySet().stream().map(e -> summarise(e.getKey(), e.getValue())).toList();
        }

        private AircraftUsage summarise(String icao24, List<Row> track) {
            double distanceKm = 0.0;
            double airborneSeconds = 0.0;
            for (int i = 1; i < track.size(); i++) {
                Row prev = track.get(i - 1);
                Row curr = track.get(i);
                distanceKm += haversineKm(prev, curr);
                if (!prev.onGround() && !curr.onGround()) {
                    airborneSeconds += Duration.between(prev.observedAt(), curr.observedAt()).getSeconds();
                }
            }
            double airborneHours = airborneSeconds / 3600.0;
            double avgSpeedKmh = airborneHours > 0 ? distanceKm / airborneHours : 0.0;
            String registration = jdbc.sql("SELECT registration FROM aircraft WHERE icao24 = :i")
                    .param("i", icao24).query(String.class).optional().orElse(null);
            return new AircraftUsage(icao24, registration, track.size(),
                    round2(distanceKm), round2(airborneHours), round2(avgSpeedKmh));
        }

        private static double haversineKm(Row a, Row b) {
            double dLat = Math.toRadians(b.latitude() - a.latitude());
            double dLon = Math.toRadians(b.longitude() - a.longitude());
            double h = Math.sin(dLat / 2) * Math.sin(dLat / 2)
                    + Math.cos(Math.toRadians(a.latitude())) * Math.cos(Math.toRadians(b.latitude()))
                    * Math.sin(dLon / 2) * Math.sin(dLon / 2);
            return 6371.0 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
        }

        private static double round2(double v) {
            return Math.round(v * 100.0) / 100.0;
        }
    }
}
