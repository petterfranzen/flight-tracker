package com.flighttracker.service;

import com.flighttracker.model.FlightPosition;

import java.time.Duration;
import java.time.Instant;

/**
 * "Fills in" a flight's position between real ADS-B reports by dead-
 * reckoning forward from its last known position at its last known
 * heading and groundspeed. Two situations this exists for: an aircraft
 * that's flown outside ADS-B ground-receiver coverage (the classic
 * transatlantic-crossing case — no *new* report arrives for a long
 * stretch even though the flight is obviously still airborne and en
 * route) and an aircraft only covered by the multi-minute global sweep
 * (see AgentOrchestrator), which is only as fresh as
 * global-sweep-interval-seconds under perfectly normal operation. In both,
 * the alternative is showing a stale, visually "frozen" position long
 * after the aircraft has actually moved on; projecting forward along its
 * own last-known great-circle track is a better estimate of where it
 * actually is right now.
 *
 * A pure function of its inputs and wall-clock time — no scheduling, no
 * state, no extra API calls (it never touches OpenSky/adsbdb or the
 * database itself). EstimatedPositionCache is what actually schedules and
 * caches calls to this on a fixed interval; this class only knows how to
 * answer "where is this aircraft now," not when to ask.
 *
 * Deliberately simple: constant heading/speed along the great circle
 * defined by the last known heading (the same *shape* as a real long-haul
 * route, unlike a straight line on a flat projection or a constant-
 * compass-bearing rhumb line) — no fixed time limit on how far forward
 * that's allowed to run. Instead, the flight's own filed destination is
 * the stopping condition: if it hasn't plausibly reached it yet, it
 * hasn't landed, so it's reasonable to keep assuming it's continuing
 * along the way there. The moment the projected distance would reach the
 * destination, the estimate clips there instead of continuing past it —
 * see estimate()'s destinationLat/destinationLon parameters, without
 * which no estimate is produced at all, for exactly that reason: there'd
 * be no sound stopping condition to project toward.
 */
public final class EstimatedPositionService {

    // Below this speed, "continuing on its last heading" stops being a
    // meaningful assumption — taxiing, a momentary lull in a glitchy
    // report, etc. Same threshold/reasoning as AircraftController's ETA
    // calc (MIN_ETA_GROUNDSPEED_MS).
    //
    // TODO (not yet addressed): this whole class assumes one aircraft
    // profile — fixed-wing, cruising, can only "land" at an airport at
    // roughly its filed destination. A helicopter (or similarly a seaplane,
    // a glider, a military/utility aircraft flying a survey/patrol pattern)
    // breaks several of these assumptions at once: it can land almost
    // anywhere (not just at destinationLat/destinationLon), cruises far
    // slower (MIN_SPEED_MS could wrongly discard a real, slow-but-genuine
    // track), and often isn't heading in a straight line toward a single
    // filed destination at all (loitering, ferrying between arbitrary
    // points). Distinguishing aircraft type (from Aircraft.model, once
    // enriched) and branching the guards/behavior here accordingly is
    // future work, not done as part of this pass.
    private static final double MIN_SPEED_MS = 20;

    // Don't bother projecting a report that's barely aged — the resulting
    // shift is sub-pixel at any real map zoom, and it's not worth the
    // (tiny) extra compute for something imperceptible.
    private static final Duration MIN_AGE = Duration.ofSeconds(10);

    private static final double EARTH_RADIUS_M = 6_371_000;

    private EstimatedPositionService() {
    }

    /**
     * @param last the last real position on record for this aircraft.
     * @param asOf "now", or whatever instant to estimate for.
     * @param destinationLat filed destination airport latitude, or null
     *                       if unknown.
     * @param destinationLon filed destination airport longitude, or null
     *                       if unknown.
     * @return {@code last} unchanged if extrapolation isn't warranted — on
     *         the ground, no usable heading/speed, too fresh to bother
     *         (see MIN_SPEED_MS/MIN_AGE), or the destination isn't known
     *         (with no destination there's no sound stopping point to
     *         project toward, so this deliberately doesn't guess one via
     *         an arbitrary time/distance cap). Otherwise a copy with
     *         latitude/longitude projected forward — never past the
     *         destination; once dead reckoning says it should already be
     *         there, the estimate clips at that point rather than
     *         continuing on. Every other field (altitude, velocity,
     *         heading, callsign, observedAt, etc.) is carried over
     *         unchanged from {@code last} — only position moves. Never
     *         mutates {@code last}, and the result is never persisted —
     *         it's a synthetic value, held only in EstimatedPositionCache.
     */
    public static FlightPosition estimate(FlightPosition last, Instant asOf,
                                           Double destinationLat, Double destinationLon) {
        if (last == null || last.isOnGround()) return last;
        if (destinationLat == null || destinationLon == null) return last;
        Double speed = last.getVelocityMs();
        Double heading = last.getHeadingDeg();
        if (speed == null || speed < MIN_SPEED_MS || heading == null) return last;

        Duration elapsed = Duration.between(last.getObservedAt(), asOf);
        if (elapsed.compareTo(MIN_AGE) < 0) return last;

        double distanceToDestinationM = haversineMeters(
                last.getLatitude(), last.getLongitude(), destinationLat, destinationLon);
        double projectedDistanceM = speed * elapsed.toSeconds();
        // Never project past the destination — once elapsed time at this
        // groundspeed would already cover the remaining distance, the
        // better estimate is "at (or essentially at) the destination,
        // presumably on approach or just landed outside ADS-B coverage"
        // rather than continuing on past it.
        double distanceM = Math.min(projectedDistanceM, distanceToDestinationM);

        double[] projected = destinationPoint(last.getLatitude(), last.getLongitude(), heading, distanceM);
        return last.withEstimatedPosition(projected[0], projected[1]);
    }

    // Standard spherical "destination point given start point, initial
    // bearing, and distance" formula (the direct geodesic problem on a
    // sphere) — walks along the great circle whose initial bearing at the
    // start point is bearingDeg, which is exactly the aircraft's own
    // last-known track continued forward.
    private static double[] destinationPoint(double latDeg, double lonDeg, double bearingDeg, double distanceM) {
        double phi1 = Math.toRadians(latDeg);
        double lambda1 = Math.toRadians(lonDeg);
        double theta = Math.toRadians(bearingDeg);
        double delta = distanceM / EARTH_RADIUS_M;

        double phi2 = Math.asin(Math.sin(phi1) * Math.cos(delta) + Math.cos(phi1) * Math.sin(delta) * Math.cos(theta));
        double lambda2 = lambda1 + Math.atan2(
                Math.sin(theta) * Math.sin(delta) * Math.cos(phi1),
                Math.cos(delta) - Math.sin(phi1) * Math.sin(phi2));

        // Normalized to [-180, 180) so it stays a valid lat/lon pair even
        // after wrapping around the antimeridian (a genuinely reachable
        // case here: a Pacific-crossing flight, for instance).
        double lonResult = ((Math.toDegrees(lambda2) + 540) % 360) - 180;
        return new double[] { Math.toDegrees(phi2), lonResult };
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
