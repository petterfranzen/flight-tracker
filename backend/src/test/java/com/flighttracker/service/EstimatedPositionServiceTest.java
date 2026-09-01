package com.flighttracker.service;

import com.flighttracker.model.FlightPosition;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.time.temporal.ChronoUnit;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Pure-function tests, no DB/Spring context needed — estimate() only
 * touches its own inputs and wall-clock time (see its class javadoc).
 */
class EstimatedPositionServiceTest {

    private static final Instant OBSERVED_AT = Instant.parse("2026-09-01T12:00:00Z");
    private static final double EARTH_RADIUS_M = 6_371_000;

    private static FlightPosition position(double lat, double lon, Double velocityMs, Double headingDeg, boolean onGround) {
        return new FlightPosition("abc123", "SAS123", OBSERVED_AT, lat, lon,
                10_000.0, velocityMs, headingDeg, -2.5, onGround, "opensky");
    }

    @Test
    void onGround_returnsInputUnchanged() {
        FlightPosition last = position(59.0, 18.0, 200.0, 90.0, true);
        FlightPosition result = EstimatedPositionService.estimate(last, OBSERVED_AT.plusSeconds(1000), 0.0, 90.0);
        assertThat(result).isSameAs(last);
    }

    @Test
    void nullDestinationLat_returnsInputUnchanged() {
        FlightPosition last = position(59.0, 18.0, 200.0, 90.0, false);
        FlightPosition result = EstimatedPositionService.estimate(last, OBSERVED_AT.plusSeconds(1000), null, 90.0);
        assertThat(result).isSameAs(last);
    }

    @Test
    void nullDestinationLon_returnsInputUnchanged() {
        FlightPosition last = position(59.0, 18.0, 200.0, 90.0, false);
        FlightPosition result = EstimatedPositionService.estimate(last, OBSERVED_AT.plusSeconds(1000), 0.0, null);
        assertThat(result).isSameAs(last);
    }

    @Test
    void nullVelocity_returnsInputUnchanged() {
        FlightPosition last = position(59.0, 18.0, null, 90.0, false);
        FlightPosition result = EstimatedPositionService.estimate(last, OBSERVED_AT.plusSeconds(1000), 0.0, 90.0);
        assertThat(result).isSameAs(last);
    }

    @Test
    void nullHeading_returnsInputUnchanged() {
        FlightPosition last = position(59.0, 18.0, 200.0, null, false);
        FlightPosition result = EstimatedPositionService.estimate(last, OBSERVED_AT.plusSeconds(1000), 0.0, 90.0);
        assertThat(result).isSameAs(last);
    }

    @Test
    void speedBelowMinimum_returnsInputUnchanged() {
        FlightPosition last = position(59.0, 18.0, 19.9, 90.0, false); // MIN_SPEED_MS = 20
        FlightPosition result = EstimatedPositionService.estimate(last, OBSERVED_AT.plusSeconds(1000), 0.0, 90.0);
        assertThat(result).isSameAs(last);
    }

    @Test
    void ageBelowMinimum_returnsInputUnchanged() {
        FlightPosition last = position(59.0, 18.0, 200.0, 90.0, false); // MIN_AGE = 10s
        FlightPosition result = EstimatedPositionService.estimate(last, OBSERVED_AT.plus(5, ChronoUnit.SECONDS), 0.0, 90.0);
        assertThat(result).isSameAs(last);
    }

    /**
     * Due east on the equator is the one case simple enough to hand-verify
     * independently of destinationPoint()'s own trig: 1 degree of
     * longitude at the equator corresponds to exactly
     * EARTH_RADIUS_M * radians(1°) meters of due-east travel, and latitude
     * shouldn't move at all. Speed/elapsed are chosen so the projected
     * distance is exactly that many meters. Also verifies every
     * non-position field is carried over verbatim from `last`.
     */
    @Test
    void dueEastProjection_matchesHandComputedCoordinates_andCarriesOtherFieldsVerbatim() {
        double distanceForOneDegreeM = EARTH_RADIUS_M * Math.toRadians(1.0);
        double speed = distanceForOneDegreeM / 1000.0; // over 1000s elapsed
        FlightPosition last = position(0.0, 0.0, speed, 90.0, false);
        // Destination far enough away (quarter of the way round the
        // equator) that this projection can't possibly clip against it.
        FlightPosition result = EstimatedPositionService.estimate(
                last, OBSERVED_AT.plusSeconds(1000), 0.0, 90.0);

        assertThat(result.getLatitude()).isCloseTo(0.0, org.assertj.core.data.Offset.offset(1e-6));
        assertThat(result.getLongitude()).isCloseTo(1.0, org.assertj.core.data.Offset.offset(1e-6));

        assertThat(result.getIcao24()).isEqualTo(last.getIcao24());
        assertThat(result.getCallsign()).isEqualTo(last.getCallsign());
        assertThat(result.getObservedAt()).isEqualTo(last.getObservedAt());
        assertThat(result.getAltitudeM()).isEqualTo(last.getAltitudeM());
        assertThat(result.getVelocityMs()).isEqualTo(last.getVelocityMs());
        assertThat(result.getHeadingDeg()).isEqualTo(last.getHeadingDeg());
        assertThat(result.getVerticalRateMs()).isEqualTo(last.getVerticalRateMs());
        assertThat(result.isOnGround()).isEqualTo(last.isOnGround());
        assertThat(result.getAgentSource()).isEqualTo(last.getAgentSource());
    }

    /**
     * Destination due east, close enough that the uncapped projection
     * would fly straight past it — the estimate must clip at the
     * destination's own distance instead. Due east on the equator again,
     * so "clips at the destination" is checkable as an exact coordinate
     * match, not just "distance capped somewhere."
     */
    @Test
    void projectionPastDestination_clipsAtDestination() {
        double distanceForHalfDegreeM = EARTH_RADIUS_M * Math.toRadians(0.5);
        double distanceForTwoDegreesM = EARTH_RADIUS_M * Math.toRadians(2.0);
        double speed = distanceForTwoDegreesM / 1000.0; // uncapped projection: ~2 degrees
        FlightPosition last = position(0.0, 0.0, speed, 90.0, false);

        FlightPosition result = EstimatedPositionService.estimate(
                last, OBSERVED_AT.plusSeconds(1000), 0.0, 0.5);

        assertThat(distanceForHalfDegreeM).isPositive(); // sanity: destination is closer than the uncapped projection
        assertThat(result.getLatitude()).isCloseTo(0.0, org.assertj.core.data.Offset.offset(1e-6));
        assertThat(result.getLongitude()).isCloseTo(0.5, org.assertj.core.data.Offset.offset(1e-6));
    }

    /**
     * Crossing the antimeridian while heading due east must wrap into
     * [-180, 180), not continue past 180.
     */
    @Test
    void antimeridianCrossing_normalizesLongitude() {
        double distanceForOneDegreeM = EARTH_RADIUS_M * Math.toRadians(1.0);
        double speed = distanceForOneDegreeM / 1000.0;
        FlightPosition last = position(0.0, 179.5, speed, 90.0, false);
        // Destination far past the antimeridian, well beyond the ~1 degree
        // this projection covers, so it can't clip.
        FlightPosition result = EstimatedPositionService.estimate(
                last, OBSERVED_AT.plusSeconds(1000), 0.0, -170.0);

        assertThat(result.getLongitude()).isCloseTo(-179.5, org.assertj.core.data.Offset.offset(1e-6));
        assertThat(result.getLongitude()).isGreaterThanOrEqualTo(-180.0).isLessThan(180.0);
    }
}
