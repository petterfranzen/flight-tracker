package com.flighttracker.service.training;

import com.flighttracker.service.coverage.ApproachGeometry;
import com.flighttracker.service.coverage.GapEstimate;
import com.flighttracker.service.coverage.TrackPoint;
import com.flighttracker.service.coverage.TrackState;
import com.flighttracker.service.live.LiveAircraft;

import java.time.Duration;
import java.time.Instant;
import java.util.List;

/**
 * The compact numeric description of one track end (an aircraft that went
 * silent inside coverage): what the capture writes to track_end_feature and
 * what a {@link LandingModel} sees. Everything except the identity, the
 * position and the physics output is nullable, because sources do not always
 * report altitude, speed or vertical rate.
 *
 * @param lastObservedAt        the last real report before the gap
 * @param originIcao            from the callsign route, or null
 * @param destinationIcao       from the callsign route, or null
 * @param pointCount            reports in the snapshot, the last one included
 * @param windowSeconds         time between the first and the last report in the snapshot
 * @param altitudeChangeM       last altitude minus the first reported one in the snapshot
 * @param meanVerticalRateMs    mean of the reported vertical rates in the snapshot
 * @param geometry              the approach features of the physics estimate
 * @param state                 the physics state at capture (COVERAGE_LOST or LANDED_INFERRED)
 * @param landingProbability    the physics probability at capture
 * @param estimatorModel        id of the estimator that produced the physics output
 */
public record TrackEndFeatures(String icao24,
                               Instant lastObservedAt,
                               String callsign,
                               String originIcao,
                               String destinationIcao,
                               double lat,
                               double lon,
                               Double altitudeM,
                               Double verticalRateMs,
                               Double groundSpeedMs,
                               Double trackDeg,
                               int pointCount,
                               Double windowSeconds,
                               Double altitudeChangeM,
                               Double meanVerticalRateMs,
                               ApproachGeometry geometry,
                               TrackState state,
                               double landingProbability,
                               Instant touchdownAt,
                               String landingAirportIcao,
                               String landingRunway,
                               String estimatorModel) {

    /** Bumped whenever a column's meaning changes, so old and new rows are never mixed up in training. */
    public static final int FEATURES_VERSION = 1;

    /**
     * Builds the features from the live aircraft's last report, the snapshot
     * it was estimated from and the physics answer.
     */
    public static TrackEndFeatures of(LiveAircraft a, List<TrackPoint> recent, String originIcao,
                                      String destinationIcao, GapEstimate physics) {
        Double firstAlt = null;
        double vrSum = 0;
        int vrCount = 0;
        for (TrackPoint p : recent) {
            if (firstAlt == null && p.altitudeM() != null) firstAlt = p.altitudeM();
            if (p.verticalRateMs() != null) {
                vrSum += p.verticalRateMs();
                vrCount++;
            }
        }
        Double windowSeconds = recent.size() < 2 ? null
                : Duration.between(recent.get(0).observedAt(), recent.get(recent.size() - 1).observedAt()).toMillis() / 1000.0;
        Double altChange = firstAlt == null || a.altitudeM() == null ? null : a.altitudeM() - firstAlt;
        return new TrackEndFeatures(a.icao24(), a.observedAt(), a.callsign(), originIcao, destinationIcao,
                a.latitude(), a.longitude(), a.altitudeM(), a.verticalRateMs(), a.velocityMs(), a.headingDeg(),
                recent.size(), windowSeconds, altChange, vrCount == 0 ? null : vrSum / vrCount,
                physics.geometry(), physics.state(), physics.landingProbability(), physics.touchdownAt(),
                physics.landingAirportIcao(), physics.landingRunway(), physics.model());
    }
}
