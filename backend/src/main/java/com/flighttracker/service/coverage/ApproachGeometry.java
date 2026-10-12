package com.flighttracker.service.coverage;

/**
 * The compact numeric features of the last report relative to the candidate
 * runway. They explain the physics estimate, and a later learned model will
 * train on the same fields. Everything is nullable: the runway-relative
 * fields are null when there is no candidate (or, for a destination-only
 * fallback, when they do not apply), and the kinematic ones are null when
 * the source did not report them.
 *
 * @param heightAboveThresholdM  altitude at loss minus the threshold elevation
 * @param verticalRateMs         vertical rate at loss (positive is a climb)
 * @param groundSpeedMs          ground speed at loss
 * @param distanceToThresholdM   straight-line distance to the threshold
 * @param crossTrackM            signed offset from the extended centreline
 *                               (positive when the aircraft is to
 *                               the right of it, looking along the runway
 *                               heading)
 * @param headingDiffDeg         aircraft track minus runway heading, wrapped
 *                               to -180..180
 * @param glidePathDeviationM    actual height minus the height on a 3 degree
 *                               path from the threshold
 * @param goAroundSignature      the recent points show a climb after a
 *                               descent (or acceleration) at low height
 * @param airportIcao            the candidate's airport
 * @param runwayIdent            the candidate's runway, such as "19R"
 */
public record ApproachGeometry(Double heightAboveThresholdM,
                               Double verticalRateMs,
                               Double groundSpeedMs,
                               Double distanceToThresholdM,
                               Double crossTrackM,
                               Double headingDiffDeg,
                               Double glidePathDeviationM,
                               Boolean goAroundSignature,
                               String airportIcao,
                               String runwayIdent) {
}
