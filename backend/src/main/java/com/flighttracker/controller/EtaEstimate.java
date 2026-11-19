package com.flighttracker.controller;

import com.flighttracker.model.Aircraft;
import com.flighttracker.model.FlightPosition;

/**
 * The dossier's ETA: great-circle distance to the destination over the
 * current groundspeed.
 *
 * <p>No staleness cutoff here: most flights land within their ETA window
 * regardless of how long ago the last real report came in, so an old fix is
 * still a reasonable basis for the estimate rather than a reason to hide it —
 * same call as EstimatedPositionService dead-reckoning a stale fix forward
 * instead of giving up on it.
 */
final class EtaEstimate {

    // Below this, dividing distance by groundspeed stops being a
    // meaningful ETA and starts being a wild guess — taxiing speed, a
    // momentary lull in a stale/glitchy report, etc. Comfortably below
    // any real cruise or approach speed.
    private static final double MIN_ETA_GROUNDSPEED_MS = 20;

    private static final double EARTH_RADIUS_M = 6_371_000;

    private EtaEstimate() {
    }

    /** Minutes to the destination, or null without a destination fix or a meaningful groundspeed. */
    static Long minutes(FlightPosition current, Aircraft a) {
        if (current == null) return null;
        if (!hasDestinationFix(a) || !isMovingAirborne(current)) return null;
        double distanceM = haversineMeters(
                current.latitude(), current.longitude(),
                a.destinationAirportLat(), a.destinationAirportLon());
        return Math.round(distanceM / current.velocityMs() / 60.0);
    }

    private static boolean hasDestinationFix(Aircraft a) {
        return a.destinationAirportLat() != null && a.destinationAirportLon() != null;
    }

    private static boolean isMovingAirborne(FlightPosition p) {
        return !p.onGround() && p.velocityMs() != null && p.velocityMs() >= MIN_ETA_GROUNDSPEED_MS;
    }

    private static double haversineMeters(double lat1, double lon1, double lat2, double lon2) {
        double dLat = Math.toRadians(lat2 - lat1);
        double dLon = Math.toRadians(lon2 - lon1);
        double a = Math.sin(dLat / 2) * Math.sin(dLat / 2)
                + Math.cos(Math.toRadians(lat1)) * Math.cos(Math.toRadians(lat2))
                * Math.sin(dLon / 2) * Math.sin(dLon / 2);
        return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }
}
