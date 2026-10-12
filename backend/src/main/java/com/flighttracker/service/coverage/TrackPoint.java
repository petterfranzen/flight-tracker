package com.flighttracker.service.coverage;

import java.time.Instant;

/**
 * One real position report, in SI units. Altitude is metres above sea
 * level, ground speed and vertical rate are m/s (positive vertical rate is
 * a climb), track is degrees true. The optional fields are null when the
 * source did not report them.
 */
public record TrackPoint(Instant observedAt,
                         double lat,
                         double lon,
                         Double altitudeM,
                         Double groundSpeedMs,
                         Double trackDeg,
                         Double verticalRateMs,
                         boolean onGround) {
}
