package com.flighttracker.service.training;

import com.flighttracker.config.SqliteDataSourceConfig;
import com.flighttracker.repository.AircraftRepository;
import com.flighttracker.service.agent.PositionRetentionService;
import com.flighttracker.service.coverage.ApproachGeometry;
import com.flighttracker.service.coverage.GapEstimate;
import com.flighttracker.service.coverage.Runway;
import com.flighttracker.service.coverage.RunwayIndex;
import com.flighttracker.service.coverage.TrackPoint;
import com.flighttracker.service.coverage.TrackState;
import com.flighttracker.service.live.LiveAircraft;
import com.flighttracker.service.live.LiveStateStore;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.core.io.ClassPathResource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.init.ScriptUtils;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.util.ReflectionTestUtils;
import org.springframework.transaction.support.TransactionTemplate;

import javax.sql.DataSource;
import java.io.Closeable;
import java.nio.file.Path;
import java.sql.Connection;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Real SQLite file under @TempDir with schema.sql run unmodified, the same
 * pattern as SqlitePersistenceIntegrationTest. The service is driven the way
 * EstimatorAgent drives it: onGapEstimate / reconcile / flush.
 */
class TrainingDataIntegrationTest {

    private static final Instant NOW = Instant.parse("2026-10-12T12:00:00Z");
    private static final Instant LAST = NOW.minusSeconds(600);
    private static final Instant RESUMED = NOW.minusSeconds(60);

    private DataSource dataSource;
    private JdbcTemplate jdbc;
    private JdbcClient jdbcClient;
    private TransactionTemplate tx;
    private TrainingDataRepository repository;
    private RunwayIndex runways;

    @TempDir
    Path tempDir;

    @BeforeEach
    void setUp() throws Exception {
        dataSource = SqliteDataSourceConfig.buildDataSource(tempDir.resolve("training-test.db").toString());
        jdbc = new JdbcTemplate(dataSource);
        jdbcClient = JdbcClient.create(dataSource);
        try (Connection c = dataSource.getConnection()) {
            ScriptUtils.executeSqlScript(c, new ClassPathResource("schema.sql"));
        }
        tx = new TransactionTemplate(new DataSourceTransactionManager(dataSource));
        repository = new TrainingDataRepository(jdbcClient);
        runways = new RunwayIndex();
        runways.replace(List.of(new Runway("ESSA", "19R", 59.65, 17.92, 190, 40.0, 3300)));
    }

    @AfterEach
    void tearDown() throws Exception {
        if (dataSource instanceof Closeable c) c.close();
    }

    private TrainingDataService service() {
        return service(true);
    }

    private TrainingDataService service(boolean enabled) {
        return new TrainingDataService(repository, runways, tx, Clock.fixed(NOW, ZoneOffset.UTC), enabled, 4000);
    }

    private static LiveAircraft aircraft(String icao24, Instant observedAt, double lat, double lon,
                                         Double altitudeM, boolean onGround) {
        return new LiveAircraft(1L, icao24, "SAS123", observedAt, lat, lon, altitudeM, 70.0, 190.0, -3.0,
                onGround, "opensky", onGround ? observedAt : null, null, null, null, null);
    }

    private static GapEstimate estimate(TrackState state, double probability, String airport) {
        ApproachGeometry g = new ApproachGeometry(300.0, -3.0, 70.0, 5000.0, 20.0, 3.0, 10.0, false, airport,
                airport == null ? null : "19R");
        return new GapEstimate(state, probability, probability, 59.6, 17.9, 800, NOW, airport,
                airport == null ? null : "19R", airport == null ? null : LAST.plusSeconds(120), g, "physics-v1");
    }

    private static TrackEndFeatures features(LiveAircraft a, GapEstimate gap) {
        List<TrackPoint> recent = List.of(
                new TrackPoint(a.observedAt().minusSeconds(60), a.latitude(), a.longitude(), 700.0, 75.0, 190.0, -4.0, false),
                new TrackPoint(a.observedAt(), a.latitude(), a.longitude(), a.altitudeM(), 70.0, 190.0, -3.0, false));
        return TrackEndFeatures.of(a, recent, "ESSB", "ESSA", gap);
    }

    private long count(String table) {
        return jdbc.queryForObject("SELECT COUNT(*) FROM " + table, Long.class);
    }

    private void gap(TrainingDataService s, LiveAircraft a, GapEstimate g, boolean fresh) {
        s.onGapEstimate(a, features(a, g), fresh);
        s.flush();
    }

    // ---- capture

    @Test
    void capture_writesOneCompactRow_andIsIdempotentAcrossTicksAndRestarts() {
        LiveAircraft a = aircraft("abc123", LAST, 59.7, 17.9, 600.0, false);
        GapEstimate g = estimate(TrackState.COVERAGE_LOST, 0.2, "ESSA");

        TrainingDataService s = service();
        gap(s, a, g, true);
        gap(s, a, g, false);
        gap(s, a, g, false);
        assertThat(count("track_end_feature")).isEqualTo(1);

        // A restart: a fresh service sees the same gap as a new snapshot.
        gap(service(), a, g, true);
        assertThat(count("track_end_feature")).isEqualTo(1);

        Map<String, Object> row = jdbc.queryForMap("SELECT * FROM track_end_feature");
        assertThat(row.get("icao24")).isEqualTo("abc123");
        assertThat(row.get("last_observed_at")).isEqualTo(LAST.toEpochMilli());
        assertThat(row.get("captured_at")).isEqualTo(NOW.toEpochMilli());
        assertThat(row.get("features_version")).isEqualTo(TrackEndFeatures.FEATURES_VERSION);
        assertThat(row.get("callsign")).isEqualTo("SAS123");
        assertThat(row.get("origin_icao")).isEqualTo("ESSB");
        assertThat(row.get("destination_icao")).isEqualTo("ESSA");
        assertThat(row.get("last_altitude_m")).isEqualTo(600.0);
        assertThat(row.get("point_count")).isEqualTo(2);
        assertThat(row.get("window_seconds")).isEqualTo(60.0);
        assertThat(row.get("altitude_change_m")).isEqualTo(-100.0);
        assertThat(row.get("mean_vertical_rate_ms")).isEqualTo(-3.5);
        assertThat(row.get("geo_distance_to_threshold_m")).isEqualTo(5000.0);
        assertThat(row.get("geo_go_around_signature")).isEqualTo(0);
        assertThat(row.get("geo_airport_icao")).isEqualTo("ESSA");
        assertThat(row.get("geo_runway_ident")).isEqualTo("19R");
        assertThat(row.get("state")).isEqualTo("COVERAGE_LOST");
        assertThat(row.get("landing_probability")).isEqualTo(0.2);
        assertThat(row.get("touchdown_at")).isEqualTo(LAST.plusSeconds(120).toEpochMilli());
        assertThat(row.get("estimator_model")).isEqualTo("physics-v1");
        assertThat(row.get("inferred_state")).isNull();
    }

    @Test
    void capture_keepsLowGapsAndGapsWithACandidate_butNotHighGapsWithoutOne() {
        TrainingDataService s = service();
        gap(s, aircraft("low000", LAST, 10, 10, 1500.0, false), estimate(TrackState.COVERAGE_LOST, 0, null), true);
        gap(s, aircraft("high11", LAST, 10, 10, 11000.0, false), estimate(TrackState.COVERAGE_LOST, 0, null), true);
        gap(s, aircraft("high22", LAST, 59.7, 17.9, 11000.0, false), estimate(TrackState.COVERAGE_LOST, 0, "ESSA"), true);
        gap(s, aircraft("noalt3", LAST, 10, 10, null, false), estimate(TrackState.COVERAGE_LOST, 0, null), true);

        List<String> kept = jdbc.queryForList("SELECT icao24 FROM track_end_feature ORDER BY icao24", String.class);
        assertThat(kept).containsExactly("high22", "low000");
    }

    @Test
    void disabled_writesNothing_andLabelsNothing() {
        TrainingDataService s = service(false);
        LiveAircraft a = aircraft("abc123", LAST, 59.7, 17.9, 600.0, false);
        gap(s, a, estimate(TrackState.COVERAGE_LOST, 0.2, "ESSA"), true);
        s.reconcile(Set.of(), id -> Optional.of(aircraft(id, RESUMED, 59.6, 17.9, 0.0, true)));
        s.flush();
        s.recordConfirmedLanding("abc123", LAST, "mock", NOW, "ESSA");

        assertThat(count("track_end_feature")).isZero();
        assertThat(count("track_end_label")).isZero();
    }

    // ---- inferred update

    @Test
    void inferredColumns_areSetOnceWhenTheGapFirstReachesLandedInferred() {
        TrainingDataService s = service();
        LiveAircraft a = aircraft("abc123", LAST, 59.7, 17.9, 600.0, false);

        gap(s, a, estimate(TrackState.COVERAGE_LOST, 0.3, "ESSA"), true);
        assertThat(jdbc.queryForObject("SELECT inferred_state FROM track_end_feature", String.class)).isNull();

        gap(s, a, estimate(TrackState.LANDED_INFERRED, 0.94, "ESSA"), false);
        assertThat(jdbc.queryForObject("SELECT inferred_state FROM track_end_feature", String.class))
                .isEqualTo("LANDED_INFERRED");
        assertThat(jdbc.queryForObject("SELECT inferred_probability FROM track_end_feature", Double.class)).isEqualTo(0.94);
        assertThat(jdbc.queryForObject("SELECT inferred_at FROM track_end_feature", Long.class)).isEqualTo(NOW.toEpochMilli());

        // later ticks and a restarted service must not overwrite it
        gap(s, a, estimate(TrackState.LANDED_INFERRED, 0.97, "ESSA"), false);
        gap(service(), a, estimate(TrackState.LANDED_INFERRED, 0.97, "ESSA"), true);
        assertThat(jdbc.queryForObject("SELECT inferred_probability FROM track_end_feature", Double.class)).isEqualTo(0.94);
        // the physics columns keep the state at capture
        assertThat(jdbc.queryForObject("SELECT state FROM track_end_feature", String.class)).isEqualTo("COVERAGE_LOST");
    }

    // ---- labels

    @Test
    void resumeOnTheGround_labelsLandedWithTheNearestRunwaysAirport() {
        TrainingDataService s = service();
        gap(s, aircraft("abc123", LAST, 59.7, 17.9, 600.0, false), estimate(TrackState.COVERAGE_LOST, 0.2, "ESSA"), true);

        s.reconcile(Set.of(), id -> Optional.of(aircraft(id, RESUMED, 59.652, 17.921, 0.0, true)));
        s.flush();

        Map<String, Object> label = jdbc.queryForMap("SELECT * FROM track_end_label");
        assertThat(label.get("outcome")).isEqualTo("LANDED");
        assertThat(label.get("label_source")).isEqualTo("adsb_ground");
        assertThat(label.get("last_observed_at")).isEqualTo(LAST.toEpochMilli());
        assertThat(label.get("resumed_at")).isEqualTo(RESUMED.toEpochMilli());
        assertThat(label.get("resumed_lat")).isEqualTo(59.652);
        assertThat(label.get("gap_seconds")).isEqualTo(540);
        assertThat(label.get("landed_airport_icao")).isEqualTo("ESSA");
        assertThat(label.get("labelled_at")).isEqualTo(NOW.toEpochMilli());
    }

    @Test
    void resumeOnTheGroundFarFromAnyRunway_labelsLandedWithoutAnAirport() {
        TrainingDataService s = service();
        gap(s, aircraft("abc123", LAST, 59.7, 17.9, 600.0, false), estimate(TrackState.COVERAGE_LOST, 0.2, "ESSA"), true);

        s.reconcile(Set.of(), id -> Optional.of(aircraft(id, RESUMED, 60.5, 18.5, 0.0, true)));
        s.flush();

        assertThat(jdbc.queryForObject("SELECT outcome FROM track_end_label", String.class)).isEqualTo("LANDED");
        assertThat(jdbc.queryForObject("SELECT landed_airport_icao FROM track_end_label", String.class)).isNull();
    }

    @Test
    void resumeAirborne_labelsAirborne_onceOnly() {
        TrainingDataService s = service();
        gap(s, aircraft("abc123", LAST, 59.7, 17.9, 600.0, false), estimate(TrackState.COVERAGE_LOST, 0.2, "ESSA"), true);

        s.reconcile(Set.of(), id -> Optional.of(aircraft(id, RESUMED, 59.5, 18.1, 450.0, false)));
        s.flush();
        // The gap is closed: later ticks (with whatever the aircraft does next) do not label it again.
        s.reconcile(Set.of(), id -> Optional.of(aircraft(id, NOW, 59.4, 18.2, 0.0, true)));
        s.flush();

        Map<String, Object> label = jdbc.queryForMap("SELECT * FROM track_end_label");
        assertThat(label.get("outcome")).isEqualTo("AIRBORNE");
        assertThat(label.get("label_source")).isEqualTo("adsb_airborne");
        assertThat(label.get("landed_airport_icao")).isNull();
        assertThat(count("track_end_label")).isEqualTo(1);
    }

    @Test
    void resumeThatStartsAnotherGap_labelsTheOldOneAndCapturesTheNew() {
        TrainingDataService s = service();
        gap(s, aircraft("abc123", LAST, 59.7, 17.9, 600.0, false), estimate(TrackState.COVERAGE_LOST, 0.2, "ESSA"), true);

        // Reported again at RESUMED, then went silent again: a new snapshot with a newer report.
        gap(s, aircraft("abc123", RESUMED, 59.6, 17.95, 300.0, false), estimate(TrackState.COVERAGE_LOST, 0.5, "ESSA"), true);

        assertThat(count("track_end_feature")).isEqualTo(2);
        assertThat(jdbc.queryForObject("SELECT outcome FROM track_end_label WHERE last_observed_at = ?",
                String.class, LAST.toEpochMilli())).isEqualTo("AIRBORNE");
    }

    @Test
    void evictedAircraft_getsNoLabel_andIsForgotten() {
        TrainingDataService s = service();
        gap(s, aircraft("abc123", LAST, 59.7, 17.9, 600.0, false), estimate(TrackState.COVERAGE_LOST, 0.2, "ESSA"), true);

        s.reconcile(Set.of(), id -> Optional.empty());
        s.reconcile(Set.of(), id -> Optional.of(aircraft(id, RESUMED, 59.6, 17.9, 0.0, true)));
        s.flush();

        assertThat(count("track_end_feature")).isEqualTo(1);
        assertThat(count("track_end_label")).isZero();
    }

    @Test
    void aircraftStillInItsGap_isNotLabelled() {
        TrainingDataService s = service();
        gap(s, aircraft("abc123", LAST, 59.7, 17.9, 600.0, false), estimate(TrackState.COVERAGE_LOST, 0.2, "ESSA"), true);

        s.reconcile(Set.of("abc123"), id -> Optional.of(aircraft(id, RESUMED, 59.6, 17.9, 0.0, true)));
        s.flush();

        assertThat(count("track_end_label")).isZero();
    }

    @Test
    void firstLabelWins() {
        repository.insertLabel(new TrainingDataRepository.Label("abc123", LAST, "AIRBORNE", "adsb_airborne",
                RESUMED, 59.5, 18.1, null), NOW);
        boolean second = repository.insertLabel(new TrainingDataRepository.Label("abc123", LAST, "LANDED", "adsb_ground",
                NOW, 59.6, 17.9, "ESSA"), NOW);

        assertThat(second).isFalse();
        assertThat(jdbc.queryForObject("SELECT outcome FROM track_end_label", String.class)).isEqualTo("AIRBORNE");
    }

    // ---- provider confirmation

    @Test
    void confirmedLanding_insertsALandedLabelWithTheProviderAsSource() {
        service().recordConfirmedLanding("abc123", LAST, "flightaware", LAST.plusSeconds(300), "ESSA");

        Map<String, Object> label = jdbc.queryForMap("SELECT * FROM track_end_label");
        assertThat(label.get("outcome")).isEqualTo("LANDED");
        assertThat(label.get("label_source")).isEqualTo("flightaware");
        assertThat(label.get("resumed_at")).isEqualTo(LAST.plusSeconds(300).toEpochMilli());
        assertThat(label.get("resumed_lat")).isNull();
        assertThat(label.get("gap_seconds")).isEqualTo(300);
        assertThat(label.get("landed_airport_icao")).isEqualTo("ESSA");

        // and the ADS-B resume that arrives afterwards does not take it over
        TrainingDataService s = service();
        gap(s, aircraft("abc123", LAST, 59.7, 17.9, 600.0, false), estimate(TrackState.COVERAGE_LOST, 0.2, "ESSA"), true);
        s.reconcile(Set.of(), id -> Optional.of(aircraft(id, RESUMED, 59.5, 18.1, 450.0, false)));
        s.flush();
        assertThat(jdbc.queryForObject("SELECT label_source FROM track_end_label", String.class)).isEqualTo("flightaware");
    }

    @Test
    void confirmedLanding_overridesAnAirborneLabelOnlyWhenTheLandingFallsInsideTheGap() {
        repository.insertLabel(new TrainingDataRepository.Label("in-gap", LAST, "AIRBORNE", "adsb_airborne",
                RESUMED, 59.5, 18.1, null), NOW);
        repository.insertLabel(new TrainingDataRepository.Label("later1", LAST, "AIRBORNE", "adsb_airborne",
                RESUMED, 59.5, 18.1, null), NOW);
        TrainingDataService s = service();

        s.recordConfirmedLanding("in-gap", LAST, "mock", RESUMED.minusSeconds(120), "ESSA");
        s.recordConfirmedLanding("later1", LAST, "mock", RESUMED.plusSeconds(3600), "ESSA");

        assertThat(jdbc.queryForObject("SELECT outcome || '/' || label_source FROM track_end_label WHERE icao24 = 'in-gap'",
                String.class)).isEqualTo("LANDED/mock");
        assertThat(jdbc.queryForObject("SELECT landed_airport_icao FROM track_end_label WHERE icao24 = 'in-gap'",
                String.class)).isEqualTo("ESSA");
        assertThat(jdbc.queryForObject("SELECT outcome || '/' || label_source FROM track_end_label WHERE icao24 = 'later1'",
                String.class)).isEqualTo("AIRBORNE/adsb_airborne");
    }

    @Test
    void confirmedLanding_keepsAnAdsbGroundLabel_butFillsAMissingAirport() {
        repository.insertLabel(new TrainingDataRepository.Label("abc123", LAST, "LANDED", "adsb_ground",
                RESUMED, 60.5, 18.5, null), NOW);

        service().recordConfirmedLanding("abc123", LAST, "mock", RESUMED.minusSeconds(30), "ESSA");

        Map<String, Object> label = jdbc.queryForMap("SELECT * FROM track_end_label");
        assertThat(label.get("label_source")).isEqualTo("adsb_ground");
        assertThat(label.get("resumed_at")).isEqualTo(RESUMED.toEpochMilli());
        assertThat(label.get("landed_airport_icao")).isEqualTo("ESSA");
    }

    // ---- retention

    @Test
    void prune_removesTrainingRowsPastTheirRetention_andLeavesRecentOnes() {
        TrainingDataService s = service();
        Instant old = NOW.minus(Duration.ofDays(400));
        // captured long ago (the capture clock is NOW, so write the old row directly)
        repository.insertFeatures(features(aircraft("old001", old, 59.7, 17.9, 600.0, false),
                estimate(TrackState.COVERAGE_LOST, 0.2, "ESSA")), old);
        repository.insertLabel(new TrainingDataRepository.Label("old001", old, "AIRBORNE", "adsb_airborne",
                old.plusSeconds(60), 59.5, 18.1, null), old.plusSeconds(60));
        gap(s, aircraft("new001", LAST, 59.7, 17.9, 600.0, false), estimate(TrackState.COVERAGE_LOST, 0.2, "ESSA"), true);
        s.reconcile(Set.of(), id -> Optional.of(aircraft(id, RESUMED, 59.5, 18.1, 450.0, false)));
        s.flush();
        assertThat(count("track_end_feature")).isEqualTo(2);
        assertThat(count("track_end_label")).isEqualTo(2);

        PositionRetentionService retention = new PositionRetentionService(jdbc,
                new AircraftRepository(jdbcClient, Clock.fixed(NOW, ZoneOffset.UTC)), tx,
                Clock.fixed(NOW, ZoneOffset.UTC), new LiveStateStore(jdbc, Clock.fixed(NOW, ZoneOffset.UTC)), repository);
        ReflectionTestUtils.setField(retention, "retentionHours", 72.0);
        ReflectionTestUtils.setField(retention, "batchSize", 5000);
        ReflectionTestUtils.setField(retention, "maxBatchesPerRun", 200);
        ReflectionTestUtils.setField(retention, "trainingRetentionDays", 365);

        retention.prune();

        assertThat(jdbc.queryForList("SELECT icao24 FROM track_end_feature", String.class)).containsExactly("new001");
        assertThat(jdbc.queryForList("SELECT icao24 FROM track_end_label", String.class)).containsExactly("new001");
    }
}
