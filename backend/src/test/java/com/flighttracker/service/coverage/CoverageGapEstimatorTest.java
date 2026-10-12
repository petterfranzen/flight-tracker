package com.flighttracker.service.coverage;

import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class CoverageGapEstimatorTest {

    private static final double R = 6_371_000;
    private static final Instant LOSS = Instant.parse("2026-10-12T10:00:00Z");

    // Stockholm Arlanda, approximately: ARP elevation 42 m. 19R is the
    // threshold at the north end of the 3,301 m runway, true heading ~193.5.
    private static final double ESSA_ELEV = 42;
    private static final Runway R19R = new Runway("ESSA", "19R", 59.6720, 17.9140, 193.5, ESSA_ELEV, 3301);
    private static final double[] END_19R = dest(R19R.thresholdLat(), R19R.thresholdLon(), 193.5, 3301);
    private static final Runway R01L = new Runway("ESSA", "01L", END_19R[0], END_19R[1], 13.5, ESSA_ELEV, 3301);
    // 19L: parallel runway ~1.5 km to the east
    private static final double[] THR_19L = dest(R19R.thresholdLat(), R19R.thresholdLon(), 103.5, 1500);
    private static final Runway R19L = new Runway("ESSA", "19L", THR_19L[0], THR_19L[1], 193.5, ESSA_ELEV, 2500);
    private static final Runway R26 = new Runway("ESSA", "26", 59.6600, 17.9750, 261.0, ESSA_ELEV, 2500);
    private static final double[] END_26 = dest(R26.thresholdLat(), R26.thresholdLon(), 261.0, 2500);
    private static final Runway R08 = new Runway("ESSA", "08", END_26[0], END_26[1], 81.0, ESSA_ELEV, 2500);
    private static final List<Runway> ESSA = List.of(R19R, R01L, R19L, R26, R08);

    private final CoverageGapEstimator estimator = new CoverageGapEstimator();

    // ------------------------------------------------------------ scenario 1

    @Test
    void normalApproachIsCoverageLostThenLandedInferred() {
        double[] loss = dest(R19R.thresholdLat(), R19R.thresholdLon(), 13.5, 8_000);
        List<TrackPoint> pts = backwards(loss, 193.5, 75, ESSA_ELEV + 450, -3.5, LOSS, 40, 15);

        GapEstimate early = estimator.estimate(input(pts, ESSA, LOSS.plusSeconds(30)));
        assertThat(early.state()).isEqualTo(TrackState.COVERAGE_LOST);
        assertThat(early.landingAirportIcao()).isEqualTo("ESSA");
        assertThat(early.landingRunway()).isEqualTo("19R");
        assertThat(early.model()).isEqualTo("physics-v1");
        assertThat(early.at()).isEqualTo(LOSS.plusSeconds(30));
        long ttd = Duration.between(LOSS, early.touchdownAt()).toSeconds();
        assertThat(ttd).isBetween(90L, 180L);
        assertThat(early.landingProbability()).isLessThan(0.1);
        assertThat(early.confidence()).isEqualTo(1 - early.landingProbability());
        // still short of the runway, near the extended centreline
        assertThat(distanceM(early.estLat(), early.estLon(), loss[0], loss[1])).isBetween(1_500.0, 3_500.0);

        double r30 = early.radiusM();
        double r60 = estimator.estimate(input(pts, ESSA, LOSS.plusSeconds(60))).radiusM();
        double r100 = estimator.estimate(input(pts, ESSA, LOSS.plusSeconds(100))).radiusM();
        assertThat(r30).isLessThan(r60);
        assertThat(r60).isLessThan(r100);

        // touchdown is predicted but the margin has not elapsed yet: not inferred
        GapEstimate justAfter = estimator.estimate(input(pts, ESSA, LOSS.plusSeconds(ttd + 10)));
        assertThat(justAfter.state()).isEqualTo(TrackState.COVERAGE_LOST);
        assertThat(justAfter.landingProbability()).isBetween(0.0, 0.5);

        GapEstimate late = estimator.estimate(input(pts, ESSA, LOSS.plusSeconds(600)));
        assertThat(late.state()).isEqualTo(TrackState.LANDED_INFERRED);
        assertThat(late.landingProbability()).isBetween(0.85, 0.97);
        assertThat(late.confidence()).isEqualTo(late.landingProbability());
        assertThat(late.landingRunway()).isEqualTo("19R");
        assertThat(late.radiusM()).isLessThanOrEqualTo(2_000);
        double[] park = dest(R19R.thresholdLat(), R19R.thresholdLon(), 193.5, 3301 / 3.0);
        assertThat(distanceM(late.estLat(), late.estLon(), park[0], park[1])).isLessThan(50);
        assertThat(late.touchdownAt()).isEqualTo(early.touchdownAt());
        // the same on a very late look: stays inferred, capped below 1
        GapEstimate muchLater = estimator.estimate(input(pts, ESSA, LOSS.plusSeconds(3 * 3600)));
        assertThat(muchLater.state()).isEqualTo(TrackState.LANDED_INFERRED);
        assertThat(muchLater.landingProbability()).isLessThanOrEqualTo(0.97);
    }

    @Test
    void picksTheAlignedRunwayOverItsParallelNeighbour() {
        double[] loss = dest(R19R.thresholdLat(), R19R.thresholdLon(), 13.5, 8_000);
        List<TrackPoint> pts = backwards(loss, 193.5, 75, ESSA_ELEV + 450, -3.5, LOSS, 40, 15);
        GapEstimate e = estimator.estimate(input(pts, ESSA, LOSS.plusSeconds(60)));
        assertThat(e.landingRunway()).isEqualTo("19R");
        ApproachGeometry g = e.geometry();
        assertThat(g.airportIcao()).isEqualTo("ESSA");
        assertThat(g.runwayIdent()).isEqualTo("19R");
        assertThat(g.heightAboveThresholdM()).isCloseTo(450, org.assertj.core.data.Offset.offset(1.0));
        assertThat(g.distanceToThresholdM()).isCloseTo(8_000, org.assertj.core.data.Offset.offset(150.0));
        assertThat(Math.abs(g.crossTrackM())).isLessThan(100);
        assertThat(Math.abs(g.headingDiffDeg())).isLessThan(1);
        assertThat(g.glidePathDeviationM()).isBetween(-100.0, 100.0);
        assertThat(g.verticalRateMs()).isEqualTo(-3.5);
        assertThat(g.goAroundSignature()).isFalse();
    }

    @Test
    void destinationIsPreferredAndRaisesTheScore() {
        double[] loss = dest(R19R.thresholdLat(), R19R.thresholdLon(), 13.5, 8_000);
        List<TrackPoint> pts = backwards(loss, 193.5, 75, ESSA_ELEV + 450, -3.5, LOSS, 40, 15);
        Instant now = LOSS.plusSeconds(600);
        double none = estimator.estimate(input(pts, ESSA, now)).landingProbability();
        double match = estimator.estimate(new GapInput(pts, ESSA, "ESSA", 59.6519, 17.9186, now)).landingProbability();
        double other = estimator.estimate(new GapInput(pts, ESSA, "ESSB", 59.3544, 17.9418, now)).landingProbability();
        assertThat(match).isGreaterThan(none);
        assertThat(none).isGreaterThan(other);
    }

    // ------------------------------------------------------------ scenario 2

    @Test
    void goAroundNeverBecomesLandedInferred() {
        double[] a0 = dest(R19R.thresholdLat(), R19R.thresholdLon(), 13.5, 3_300);
        List<TrackPoint> pts = new ArrayList<>(backwards(a0, 193.5, 72, ESSA_ELEV + 100, -3.5, LOSS.minusSeconds(30), 30, 15));
        // three reports climbing at +5 m/s and speeding up
        double[] pos = a0;
        double alt = ESSA_ELEV + 100;
        double gs = 72;
        for (int i = 1; i <= 3; i++) {
            gs += 2.5;
            alt += 5 * 10;
            pos = dest(pos[0], pos[1], 193.5, gs * 10);
            pts.add(new TrackPoint(LOSS.minusSeconds(30).plusSeconds(10L * i), pos[0], pos[1], alt, gs, 193.5, 5.0, false));
        }
        Instant lossAt = pts.get(pts.size() - 1).observedAt();
        for (long s : new long[]{30, 120, 300, 900, 1800}) {
            GapEstimate e = estimator.estimate(input(pts, ESSA, lossAt.plusSeconds(s)));
            assertThat(e.state()).as("at +%ds", s).isEqualTo(TrackState.COVERAGE_LOST);
            assertThat(e.landingProbability()).as("at +%ds", s).isLessThan(0.3);
            assertThat(e.geometry().goAroundSignature()).isTrue();
        }
    }

    // ------------------------------------------------------------ scenario 3

    @Test
    void lowLevelOverflightAcrossTheRunwayIsNotALanding() {
        double[] loss = dest(R19R.thresholdLat(), R19R.thresholdLon(), 13.5, 3_000);
        List<TrackPoint> pts = backwards(loss, 283.5, 120, 450, 0, LOSS, 40, 15);
        assertNotLanded(pts, ESSA);
    }

    @Test
    void lowLevelParallelOffsetOverflightIsNotALanding() {
        double[] onCentreline = dest(R19R.thresholdLat(), R19R.thresholdLon(), 13.5, 8_000);
        double[] loss = dest(onCentreline[0], onCentreline[1], 103.5, 5_000);
        List<TrackPoint> pts = backwards(loss, 193.5, 120, 450, 0, LOSS, 40, 15);
        assertNotLanded(pts, ESSA);
    }

    @Test
    void levelFlightAlignedWithTheRunwayStaysLowProbability() {
        double[] loss = dest(R19R.thresholdLat(), R19R.thresholdLon(), 13.5, 8_000);
        List<TrackPoint> pts = backwards(loss, 193.5, 90, ESSA_ELEV + 450, 0, LOSS, 40, 15);
        for (long s : new long[]{60, 300, 1800}) {
            GapEstimate e = estimator.estimate(input(pts, ESSA, LOSS.plusSeconds(s)));
            assertThat(e.state()).isEqualTo(TrackState.COVERAGE_LOST);
            assertThat(e.landingProbability()).isLessThan(0.3);
        }
    }

    @Test
    void levelAlignedOverflightKeepsMovingPastTheThreshold() {
        double[] loss = dest(R19R.thresholdLat(), R19R.thresholdLon(), 13.5, 8_000);
        List<TrackPoint> pts = backwards(loss, 193.5, 90, ESSA_ELEV + 450, 0, LOSS, 40, 15);
        GapEstimate e = estimator.estimate(input(pts, ESSA, LOSS.plusSeconds(1800)));
        assertThat(e.state()).isEqualTo(TrackState.COVERAGE_LOST);
        assertThat(e.landingProbability()).isLessThan(0.3);
        // 90 m/s for 30 min is 162 km; the estimate is not parked at the 8 km threshold
        assertThat(distanceM(loss[0], loss[1], e.estLat(), e.estLon())).isBetween(150_000.0, 170_000.0);
    }

    @Test
    void unknownHeightAtJetSpeedIsNeverInferredLanded() {
        double[] loss = dest(R19R.thresholdLat(), R19R.thresholdLon(), 13.5, 30_000);
        List<TrackPoint> pts = noAltitude(loss, 193.5, 230);
        GapEstimate e = estimator.estimate(input(pts, ESSA, LOSS.plusSeconds(3600)));
        assertThat(e.state()).isEqualTo(TrackState.COVERAGE_LOST);
        assertThat(e.landingProbability()).isLessThan(0.5);
    }

    @Test
    void unknownHeightAtApproachSpeedCanStillBeInferredLanded() {
        double[] loss = dest(R19R.thresholdLat(), R19R.thresholdLon(), 13.5, 8_000);
        List<TrackPoint> pts = noAltitude(loss, 193.5, 75);
        GapEstimate e = estimator.estimate(input(pts, ESSA, LOSS.plusSeconds(1800)));
        assertThat(e.state()).isEqualTo(TrackState.LANDED_INFERRED);
        assertThat(e.landingProbability()).isGreaterThan(0.5);
    }

    // ------------------------------------------------------------ antimeridian

    @Test
    void cruiseAcrossTheAntimeridianAdvancesAlongTrack() {
        double[] loss = {60.0, -179.98};
        List<TrackPoint> pts = backwards(loss, 90, 230, 11_300, 0, LOSS, 10, 15);
        assertThat(pts.get(0).lon()).isGreaterThan(179);
        GapEstimate e = estimator.estimate(input(pts, List.of(), LOSS.plusSeconds(600)));
        double[] expected = dest(loss[0], loss[1], 90, 230.0 * 600);
        assertThat(distanceM(e.estLat(), e.estLon(), expected[0], expected[1])).isLessThan(3_000);
        assertThat(e.estLon()).isBetween(-180.0, 180.0);
        GapEstimate shortGap = estimator.estimate(input(pts, List.of(), LOSS.plusSeconds(5)));
        assertThat(distanceM(shortGap.estLat(), shortGap.estLon(), loss[0], loss[1])).isLessThan(3_000);
    }

    @Test
    void approachToARunwayNextToTheAntimeridianIsMatched() {
        Runway thr = new Runway("NFFN", "19R", 59.6720, 179.995, 193.5, 20.0, 3000);
        double[] loss = dest(thr.thresholdLat(), thr.thresholdLon(), 13.5, 8_000);
        assertThat(loss[1]).isLessThan(-179);
        List<TrackPoint> pts = backwards(loss, 193.5, 75, 20 + 450, -3.5, LOSS, 40, 15);
        GapEstimate e = estimator.estimate(input(pts, List.of(thr), LOSS.plusSeconds(900)));
        assertThat(e.state()).isEqualTo(TrackState.LANDED_INFERRED);
        assertThat(e.landingRunway()).isEqualTo("19R");
        assertThat(distanceM(e.estLat(), e.estLon(), thr.thresholdLat(), thr.thresholdLon())).isLessThan(1_500);
    }

    @Test
    void estimateInstantsHaveMillisecondPrecision() {
        double[] loss = dest(R19R.thresholdLat(), R19R.thresholdLon(), 13.5, 8_000);
        List<TrackPoint> pts = backwards(loss, 193.5, 75, ESSA_ELEV + 450, -3.5, LOSS.plusNanos(123_456_789), 40, 15);
        GapEstimate e = estimator.estimate(input(pts, ESSA, LOSS.plusSeconds(60).plusNanos(987_654_321)));
        assertThat(e.at().getNano() % 1_000_000).isZero();
        assertThat(e.touchdownAt().getNano() % 1_000_000).isZero();
    }

    private void assertNotLanded(List<TrackPoint> pts, List<Runway> runways) {
        for (long s : new long[]{30, 300, 1800}) {
            GapEstimate e = estimator.estimate(input(pts, runways, LOSS.plusSeconds(s)));
            assertThat(e.state()).as("at +%ds", s).isEqualTo(TrackState.COVERAGE_LOST);
            assertThat(e.landingProbability()).as("at +%ds", s).isLessThan(0.1);
        }
    }

    // ------------------------------------------------------------ scenario 4

    @Test
    void cruiseLeavingCoverageStaysCoverageLostAndAdvancesAlongTrack() {
        double[] loss = {60.0, 5.0};
        List<TrackPoint> pts = backwards(loss, 270, 230, 11_300, 0, LOSS, 40, 15);
        double previous = 0;
        for (long minutes : new long[]{1, 2, 5, 10, 20, 30, 45, 60, 90, 120, 150, 180}) {
            GapEstimate e = estimator.estimate(input(pts, List.of(), LOSS.plusSeconds(minutes * 60)));
            assertThat(e.state()).as("at +%d min", minutes).isEqualTo(TrackState.COVERAGE_LOST);
            assertThat(e.landingProbability()).isEqualTo(0.0);
            assertThat(e.confidence()).isEqualTo(1.0);
            assertThat(e.landingRunway()).isNull();
            assertThat(e.touchdownAt()).isNull();
            double expected = 230.0 * minutes * 60;
            double actual = distanceM(loss[0], loss[1], e.estLat(), e.estLon());
            assertThat(actual).as("distance at +%d min", minutes).isBetween(expected * 0.97, expected * 1.03);
            assertThat(e.radiusM()).as("radius at +%d min", minutes).isGreaterThan(previous);
            previous = e.radiusM();
        }
        // roughly west, i.e. the position is still on the western bearing
        GapEstimate twoHours = estimator.estimate(input(pts, List.of(), LOSS.plusSeconds(7200)));
        assertThat(twoHours.estLon()).isLessThan(loss[1]);
        assertThat(Math.abs(twoHours.estLat() - loss[0])).isLessThan(8);
    }

    // ------------------------------------------------------------ scenario 5

    @Test
    void singleReportIsEnough() {
        double[] loss = dest(R19R.thresholdLat(), R19R.thresholdLon(), 13.5, 8_000);
        List<TrackPoint> all = backwards(loss, 193.5, 75, ESSA_ELEV + 450, -3.5, LOSS, 40, 15);
        List<TrackPoint> one = List.of(all.get(all.size() - 1));

        GapEstimate single = estimator.estimate(input(one, ESSA, LOSS.plusSeconds(60)));
        GapEstimate many = estimator.estimate(input(all, ESSA, LOSS.plusSeconds(60)));
        assertThat(single.state()).isEqualTo(TrackState.COVERAGE_LOST);
        assertThat(single.landingRunway()).isEqualTo("19R");
        // wider initial covariance than a filtered history
        assertThat(single.radiusM()).isGreaterThan(many.radiusM());
        assertThat(estimator.estimate(input(one, ESSA, LOSS.plusSeconds(900))).state())
                .isEqualTo(TrackState.LANDED_INFERRED);
    }

    @Test
    void singleReportWithoutVelocityStaysPutWithABigRadius() {
        TrackPoint p = new TrackPoint(LOSS, 59.0, 18.0, null, null, null, null, false);
        GapEstimate e = estimator.estimate(input(List.of(p), List.of(), LOSS.plusSeconds(60)));
        assertThat(e.state()).isEqualTo(TrackState.COVERAGE_LOST);
        assertThat(e.estLat()).isEqualTo(59.0);
        assertThat(e.estLon()).isEqualTo(18.0);
        assertThat(e.radiusM()).isGreaterThan(5_000);
        assertThat(e.landingProbability()).isEqualTo(0.0);
    }

    @Test
    void noRunwaysAndNoDestinationDescendingStillOnlyDeadReckons() {
        double[] loss = dest(R19R.thresholdLat(), R19R.thresholdLon(), 13.5, 8_000);
        List<TrackPoint> pts = backwards(loss, 193.5, 75, ESSA_ELEV + 450, -3.5, LOSS, 40, 15);
        GapEstimate e = estimator.estimate(input(pts, List.of(), LOSS.plusSeconds(1800)));
        assertThat(e.state()).isEqualTo(TrackState.COVERAGE_LOST);
        assertThat(e.landingProbability()).isEqualTo(0.0);
        assertThat(e.landingAirportIcao()).isNull();
        assertThat(e.landingRunway()).isNull();
        assertThat(e.touchdownAt()).isNull();
        assertThat(e.geometry()).isNotNull();
        assertThat(e.geometry().runwayIdent()).isNull();
    }

    @Test
    void destinationOnlyFallbackIsModerate() {
        // 12 km short of ESSA, descending, no runways supplied
        double[] arp = {59.6519, 17.9186};
        double[] loss = dest(arp[0], arp[1], 13.5, 12_000);
        List<TrackPoint> pts = backwards(loss, 193.5, 80, 600, -4, LOSS, 40, 15);
        GapInput in = new GapInput(pts, List.of(), "ESSA", arp[0], arp[1], LOSS.plusSeconds(1200));
        GapEstimate e = estimator.estimate(in);
        assertThat(e.landingRunway()).isNull();
        assertThat(e.landingAirportIcao()).isEqualTo("ESSA");
        assertThat(e.landingProbability()).isBetween(0.3, 0.8);
        assertThat(e.landingProbability()).isLessThan(0.85);
        if (e.state() == TrackState.LANDED_INFERRED) {
            assertThat(distanceM(e.estLat(), e.estLon(), arp[0], arp[1])).isLessThan(1);
        }
    }

    @Test
    void destinationFallbackIgnoresAnAircraftThatIsNotDescendingOrTooFar() {
        double[] arp = {59.6519, 17.9186};
        double[] near = dest(arp[0], arp[1], 13.5, 12_000);
        List<TrackPoint> level = backwards(near, 193.5, 80, 3_000, 0, LOSS, 40, 15);
        assertThat(estimator.estimate(new GapInput(level, List.of(), "ESSA", arp[0], arp[1], LOSS.plusSeconds(1200)))
                .landingProbability()).isEqualTo(0.0);
        double[] far = dest(arp[0], arp[1], 13.5, 80_000);
        List<TrackPoint> descendingFar = backwards(far, 193.5, 80, 600, -4, LOSS, 40, 15);
        assertThat(estimator.estimate(new GapInput(descendingFar, List.of(), "ESSA", arp[0], arp[1], LOSS.plusSeconds(1200)))
                .landingProbability()).isEqualTo(0.0);
    }

    @Test
    void emptyHistoryIsRejected() {
        assertThatThrownBy(() -> estimator.estimate(input(List.of(), List.of(), LOSS)))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void trackStateHasTheAgreedValuesInOrder() {
        assertThat(TrackState.values()).containsExactly(TrackState.LIVE, TrackState.COVERAGE_LOST,
                TrackState.LANDED_INFERRED, TrackState.ON_GROUND, TrackState.LANDED_CONFIRMED, TrackState.AT_GATE);
    }

    // ---------------------------------------------------------------- helpers

    private static GapInput input(List<TrackPoint> pts, List<Runway> runways, Instant now) {
        return new GapInput(pts, runways, null, null, null, now);
    }

    /** Reports of a straight flight that ends at {@code last} at {@code lastAt}, oldest first. */
    private static List<TrackPoint> backwards(double[] last, double track, double gs, double alt, double vs,
                                              Instant lastAt, int n, int spacingS) {
        List<TrackPoint> out = new ArrayList<>();
        for (int i = n - 1; i >= 0; i--) {
            double dt = (double) (n - 1 - i) * spacingS;
            double[] p = dest(last[0], last[1], track + 180, gs * dt);
            out.add(0, new TrackPoint(lastAt.minusSeconds((long) dt), p[0], p[1], alt - vs * dt, gs, track, vs, false));
        }
        return out;
    }

    /** Reports with neither altitude nor vertical rate, ending at {@code last} at LOSS. */
    private static List<TrackPoint> noAltitude(double[] last, double track, double gs) {
        List<TrackPoint> out = new ArrayList<>();
        for (int i = 39; i >= 0; i--) {
            double[] p = dest(last[0], last[1], track + 180, gs * 15.0 * i);
            out.add(new TrackPoint(LOSS.minusSeconds(15L * i), p[0], p[1], null, gs, track, null, false));
        }
        return out;
    }

    private static double[] dest(double latDeg, double lonDeg, double bearingDeg, double distanceM) {
        double phi1 = Math.toRadians(latDeg);
        double lambda1 = Math.toRadians(lonDeg);
        double theta = Math.toRadians(bearingDeg);
        double delta = distanceM / R;
        double phi2 = Math.asin(Math.sin(phi1) * Math.cos(delta) + Math.cos(phi1) * Math.sin(delta) * Math.cos(theta));
        double lambda2 = lambda1 + Math.atan2(Math.sin(theta) * Math.sin(delta) * Math.cos(phi1),
                Math.cos(delta) - Math.sin(phi1) * Math.sin(phi2));
        return new double[]{Math.toDegrees(phi2), ((Math.toDegrees(lambda2) + 540) % 360) - 180};
    }

    private static double distanceM(double lat1, double lon1, double lat2, double lon2) {
        double dLat = Math.toRadians(lat2 - lat1);
        double dLon = Math.toRadians(lon2 - lon1);
        double a = Math.sin(dLat / 2) * Math.sin(dLat / 2)
                + Math.cos(Math.toRadians(lat1)) * Math.cos(Math.toRadians(lat2))
                * Math.sin(dLon / 2) * Math.sin(dLon / 2);
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }
}
