package com.flighttracker.service.coverage;

import java.time.Instant;
import java.util.List;

/**
 * Everything the estimator sees: a fixed snapshot of the last reports, the
 * runways near the last report, the filed destination (all three parts
 * nullable) and the instant to estimate for.
 *
 * @param recent         reports oldest to newest; the last is the last one
 *                       before the gap, and the list typically spans ~10 min
 * @param nearbyRunways  already filtered by the caller to roughly 50 km
 *                       around the last report
 */
public record GapInput(List<TrackPoint> recent,
                       List<Runway> nearbyRunways,
                       String destinationIcao,
                       Double destinationLat,
                       Double destinationLon,
                       Instant now) {
}
