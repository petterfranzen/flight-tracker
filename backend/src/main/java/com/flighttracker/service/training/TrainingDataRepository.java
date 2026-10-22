package com.flighttracker.service.training;

import com.flighttracker.service.coverage.ApproachGeometry;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

import java.time.Instant;

import static com.flighttracker.repository.Timestamps.toEpochMilli;

/**
 * The track_end_feature and track_end_label tables, see schema.sql. Unlike
 * flight_position these are small and may be updated: a feature row gets its
 * inferred_* columns once, and a label can be replaced by a provider's
 * confirmation (see {@link #confirmLanded}).
 */
@Repository
public class TrainingDataRepository {

    /** A label to write; {@code airportIcao} is null when the landing airport is unknown. */
    public record Label(String icao24, Instant lastObservedAt, String outcome, String source,
                        Instant resumedAt, Double resumedLat, Double resumedLon, String airportIcao) {
        public static final String LANDED = "LANDED";
        public static final String AIRBORNE = "AIRBORNE";
    }

    private final JdbcClient jdbcClient;

    public TrainingDataRepository(JdbcClient jdbcClient) {
        this.jdbcClient = jdbcClient;
    }

    /** Idempotent: the first row for (icao24, last_observed_at) stays. */
    public boolean insertFeatures(TrackEndFeatures f, Instant capturedAt) {
        ApproachGeometry g = f.geometry();
        return jdbcClient.sql("""
                INSERT INTO track_end_feature (icao24, last_observed_at, captured_at, features_version,
                    callsign, origin_icao, destination_icao,
                    last_lat, last_lon, last_altitude_m, last_vertical_rate_ms, last_ground_speed_ms, last_track_deg,
                    point_count, window_seconds, altitude_change_m, mean_vertical_rate_ms,
                    geo_height_above_threshold_m, geo_vertical_rate_ms, geo_ground_speed_ms,
                    geo_distance_to_threshold_m, geo_cross_track_m, geo_heading_diff_deg,
                    geo_glide_path_deviation_m, geo_go_around_signature, geo_airport_icao, geo_runway_ident,
                    state, landing_probability, touchdown_at, landing_airport_icao, landing_runway, estimator_model)
                VALUES (:icao24, :lastObservedAt, :capturedAt, :version,
                    :callsign, :origin, :destination,
                    :lat, :lon, :alt, :vr, :gs, :track,
                    :points, :window, :altChange, :meanVr,
                    :gHeight, :gVr, :gGs, :gDist, :gCross, :gHeadingDiff,
                    :gGlide, :gGoAround, :gAirport, :gRunway,
                    :state, :probability, :touchdownAt, :landingAirport, :landingRunway, :model)
                ON CONFLICT (icao24, last_observed_at) DO NOTHING
                """)
                .param("icao24", f.icao24())
                .param("lastObservedAt", toEpochMilli(f.lastObservedAt()))
                .param("capturedAt", toEpochMilli(capturedAt))
                .param("version", TrackEndFeatures.FEATURES_VERSION)
                .param("callsign", f.callsign())
                .param("origin", f.originIcao())
                .param("destination", f.destinationIcao())
                .param("lat", f.lat())
                .param("lon", f.lon())
                .param("alt", f.altitudeM())
                .param("vr", f.verticalRateMs())
                .param("gs", f.groundSpeedMs())
                .param("track", f.trackDeg())
                .param("points", f.pointCount())
                .param("window", f.windowSeconds())
                .param("altChange", f.altitudeChangeM())
                .param("meanVr", f.meanVerticalRateMs())
                .param("gHeight", g == null ? null : g.heightAboveThresholdM())
                .param("gVr", g == null ? null : g.verticalRateMs())
                .param("gGs", g == null ? null : g.groundSpeedMs())
                .param("gDist", g == null ? null : g.distanceToThresholdM())
                .param("gCross", g == null ? null : g.crossTrackM())
                .param("gHeadingDiff", g == null ? null : g.headingDiffDeg())
                .param("gGlide", g == null ? null : g.glidePathDeviationM())
                .param("gGoAround", g == null || g.goAroundSignature() == null ? null : (g.goAroundSignature() ? 1 : 0))
                .param("gAirport", g == null ? null : g.airportIcao())
                .param("gRunway", g == null ? null : g.runwayIdent())
                .param("state", f.state().name())
                .param("probability", f.landingProbability())
                .param("touchdownAt", toEpochMilli(f.touchdownAt()))
                .param("landingAirport", f.landingAirportIcao())
                .param("landingRunway", f.landingRunway())
                .param("model", f.estimatorModel())
                .update() > 0;
    }

    /** Sets the inferred_* columns once; later calls (or a row that was never captured) change nothing. */
    public boolean markInferred(String icao24, Instant lastObservedAt, String state, double probability, Instant at) {
        return jdbcClient.sql("""
                UPDATE track_end_feature
                SET inferred_state = :state, inferred_probability = :probability, inferred_at = :at
                WHERE icao24 = :icao24 AND last_observed_at = :lastObservedAt AND inferred_state IS NULL
                """)
                .param("state", state)
                .param("probability", probability)
                .param("at", toEpochMilli(at))
                .param("icao24", icao24)
                .param("lastObservedAt", toEpochMilli(lastObservedAt))
                .update() > 0;
    }

    /** Idempotent: the first label for the track end stays. */
    public boolean insertLabel(Label l, Instant labelledAt) {
        return jdbcClient.sql("""
                INSERT INTO track_end_label (icao24, last_observed_at, outcome, label_source,
                    resumed_at, resumed_lat, resumed_lon, gap_seconds, landed_airport_icao, labelled_at)
                VALUES (:icao24, :lastObservedAt, :outcome, :source,
                    :resumedAt, :resumedLat, :resumedLon, :gapSeconds, :airport, :labelledAt)
                ON CONFLICT (icao24, last_observed_at) DO NOTHING
                """)
                .params(labelParams(l, labelledAt))
                .update() > 0;
    }

    /**
     * A provider's confirmation that the aircraft landed at {@code l.resumedAt()}.
     * Inserts a LANDED label when there is none. An existing label stays,
     * with two exceptions. An adsb_airborne label is replaced when the landing
     * falls at or before the moment ADS-B saw the aircraft airborne again,
     * because then the aircraft landed inside the gap (a turnaround that
     * ADS-B missed) and AIRBORNE was wrong for the question the label answers.
     * A landing after that moment belongs to a later flight and leaves the
     * label alone. A LANDED label that lacks an airport gets the provider's.
     */
    public void confirmLanded(Label l, Instant labelledAt) {
        jdbcClient.sql("""
                INSERT INTO track_end_label (icao24, last_observed_at, outcome, label_source,
                    resumed_at, resumed_lat, resumed_lon, gap_seconds, landed_airport_icao, labelled_at)
                VALUES (:icao24, :lastObservedAt, :outcome, :source,
                    :resumedAt, :resumedLat, :resumedLon, :gapSeconds, :airport, :labelledAt)
                ON CONFLICT (icao24, last_observed_at) DO UPDATE SET
                    outcome = excluded.outcome,
                    label_source = excluded.label_source,
                    resumed_at = excluded.resumed_at,
                    resumed_lat = excluded.resumed_lat,
                    resumed_lon = excluded.resumed_lon,
                    gap_seconds = excluded.gap_seconds,
                    landed_airport_icao = excluded.landed_airport_icao,
                    labelled_at = excluded.labelled_at
                WHERE track_end_label.outcome = 'AIRBORNE'
                  AND track_end_label.label_source = 'adsb_airborne'
                  AND excluded.resumed_at <= track_end_label.resumed_at
                """)
                .params(labelParams(l, labelledAt))
                .update();
        if (l.airportIcao() != null) {
            jdbcClient.sql("""
                    UPDATE track_end_label SET landed_airport_icao = :airport
                    WHERE icao24 = :icao24 AND last_observed_at = :lastObservedAt
                      AND outcome = 'LANDED' AND landed_airport_icao IS NULL
                    """)
                    .param("airport", l.airportIcao())
                    .param("icao24", l.icao24())
                    .param("lastObservedAt", toEpochMilli(l.lastObservedAt()))
                    .update();
        }
    }

    /** @return rows deleted from track_end_feature */
    public int deleteFeaturesCapturedBefore(Instant cutoff) {
        return jdbcClient.sql("DELETE FROM track_end_feature WHERE captured_at < :cutoff")
                .param("cutoff", toEpochMilli(cutoff)).update();
    }

    /** @return rows deleted from track_end_label */
    public int deleteLabelsBefore(Instant cutoff) {
        return jdbcClient.sql("DELETE FROM track_end_label WHERE labelled_at < :cutoff")
                .param("cutoff", toEpochMilli(cutoff)).update();
    }

    private static java.util.Map<String, Object> labelParams(Label l, Instant labelledAt) {
        java.util.Map<String, Object> m = new java.util.HashMap<>();
        m.put("icao24", l.icao24());
        m.put("lastObservedAt", toEpochMilli(l.lastObservedAt()));
        m.put("outcome", l.outcome());
        m.put("source", l.source());
        m.put("resumedAt", toEpochMilli(l.resumedAt()));
        m.put("resumedLat", l.resumedLat());
        m.put("resumedLon", l.resumedLon());
        m.put("gapSeconds", l.resumedAt() == null ? null
                : Math.max(0L, (l.resumedAt().toEpochMilli() - l.lastObservedAt().toEpochMilli()) / 1000));
        m.put("airport", l.airportIcao());
        m.put("labelledAt", toEpochMilli(labelledAt));
        return m;
    }
}
