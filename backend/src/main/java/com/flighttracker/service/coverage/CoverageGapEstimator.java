package com.flighttracker.service.coverage;

import org.springframework.stereotype.Component;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

/**
 * Infers what happened to an aircraft that stopped being heard: where it
 * probably is now, how sure we are, and, if it was on approach, whether it
 * has probably landed. A pure function of a {@link GapInput}: no clock reads
 * (the input carries "now"), no database, no state, so the same snapshot can
 * be re-evaluated every few seconds while the aircraft stays silent.
 *
 * <p>Horizontal position is a constant-velocity Kalman filter run over the
 * recent reports, then predicted forward to "now". The filter gives the
 * 95% radius. The landing call is a geometric score (alignment with a
 * nearby runway, descending, low, on a plausible glide path, matching the
 * destination) times a time factor that only reaches 1 once the predicted
 * touchdown plus a margin has passed. See the constants for the numbers.
 */
@Component
public class CoverageGapEstimator {

    public static final String MODEL = "physics-v1";

    // ---- Kalman filter (local east/north tangent plane around the last report)

    /** Position measurement noise, 1 sigma. ADS-B positions are good to tens of metres; 100 m also absorbs report timing jitter. */
    private static final double POS_SIGMA_M = 100;
    /** Velocity measurement noise (from ground speed + track), 1 sigma. */
    private static final double VEL_SIGMA_MS = 3;
    /** Initial velocity uncertainty when the first point carries speed and track; wider than the measurement noise. */
    private static final double INIT_VEL_SIGMA_MS = 10;
    /** Initial velocity uncertainty when the first point has no speed or track (velocity starts at zero). */
    private static final double INIT_VEL_UNKNOWN_SIGMA_MS = 150;
    /**
     * Process noise: random acceleration, 1 sigma, to allow turns and speed
     * changes. Low and manoeuvring altitudes use the high value, cruise the
     * low one (airliners hold a heading for hours), blended linearly between.
     */
    private static final double ACCEL_SIGMA_LOW_MS2 = 1.0;
    private static final double ACCEL_SIGMA_CRUISE_MS2 = 0.1;
    private static final double ACCEL_LOW_ALT_M = 3_000;
    private static final double ACCEL_CRUISE_ALT_M = 7_000;
    /** 95% of a 2D Gaussian lies within about 2.45 sigma of the larger axis. */
    private static final double RADIUS_SIGMA_FACTOR = 2.45;
    private static final double MIN_RADIUS_M = 200;
    /** Below this filtered speed the filtered direction is noise; fall back to the reported track. */
    private static final double MIN_TRACK_SPEED_MS = 5;

    // ---- Runway candidate

    private static final double MAX_HEADING_DIFF_DEG = 30;
    private static final double OFFSET_BASE_M = 1_500;
    private static final double OFFSET_PER_DISTANCE = 0.10;
    private static final double MAX_APPROACH_DISTANCE_M = 50_000;
    /** Ranking bonus for a runway at the filed destination. */
    private static final double DESTINATION_RANK_BONUS = 0.25;
    /** Destination fallback (no aligned runway): maximum distance to the destination. */
    private static final double FALLBACK_MAX_DISTANCE_M = 30_000;
    /** A runway counts as "at the destination" by position when within this of the filed destination point. */
    private static final double DESTINATION_MATCH_RADIUS_M = 10_000;
    /** The fallback only applies to an aircraft descending faster than this (m/s). */
    private static final double FALLBACK_MIN_DESCENT_MS = 1.0;

    // ---- Time to touchdown

    /** Approach speed the aircraft slows to (m/s). */
    private static final double APPROACH_SPEED_MS = 70;
    /** Deceleration while slowing to approach speed (m/s^2). */
    private static final double APPROACH_DECEL_MS2 = 0.4;
    /** Floor on the speed used for time estimates, so a slow last report cannot produce hours. */
    private static final double MIN_ETA_SPEED_MS = 40;
    /** Touchdown is this far beyond the threshold (touchdown zone). */
    private static final double TOUCHDOWN_ZONE_M = 300;
    /** Descending faster than this (m/s) makes the height-based time meaningful. */
    private static final double MIN_DESCENT_FOR_HEIGHT_MS = 1.0;
    /** The height-based time may delay touchdown by at most this factor over the distance-based time. */
    private static final double HEIGHT_TIME_MAX_RATIO = 1.5;
    private static final double MARGIN_MIN_S = 60;
    private static final double MARGIN_RATIO = 0.5;

    // ---- Landing probability

    private static final double GLIDE_SLOPE_DEG = 3;
    /** Weights of the geometric score; they sum to 1. */
    private static final double W_ALIGNMENT = 0.30;
    private static final double W_DESCENT = 0.20;
    private static final double W_HEIGHT = 0.20;
    private static final double W_GLIDE = 0.20;
    private static final double W_DESTINATION = 0.10;
    /** Descent-rate score: 0 at -1 m/s or less steep, 1 at -2.5 m/s or steeper. */
    private static final double DESCENT_ZERO_MS = 1.0;
    private static final double DESCENT_FULL_MS = 2.5;
    /** Height score: 1 up to 500 m above the threshold, 0 from 1,500 m. */
    private static final double HEIGHT_FULL_M = 500;
    private static final double HEIGHT_ZERO_M = 1_500;
    /** Above this height a candidate runway is irrelevant (cruise or transit). */
    private static final double CRUISE_HEIGHT_M = 3_000;
    private static final double CRUISE_FACTOR = 0.05;
    /** Below this height a flare or a missing descent rate is normal, so level flight is not penalised. */
    private static final double FLARE_HEIGHT_M = 60;
    private static final double LEVEL_FACTOR = 0.3;
    /** Go-around: climbing faster than this (m/s) at low height after descending, or accelerating faster than ACCEL_MS2. */
    private static final double GO_AROUND_CLIMB_MS = 2.0;
    private static final double GO_AROUND_DESCENT_MS = 1.5;
    private static final double GO_AROUND_ACCEL_MS2 = 0.3;
    private static final double GO_AROUND_WINDOW_S = 60;
    private static final double LOW_HEIGHT_M = 1_000;
    private static final double GO_AROUND_FACTOR = 0.15;
    /** Score for components whose input was not reported. */
    private static final double UNKNOWN_SCORE = 0.3;
    /** Destination component when no destination is known. */
    private static final double DESTINATION_UNKNOWN_SCORE = 0.6;
    /** Alignment component for the destination-only fallback (no centreline evidence). */
    private static final double FALLBACK_ALIGNMENT_SCORE = 0.4;
    /** The fallback's geometric score is scaled down: it has no alignment evidence. */
    private static final double FALLBACK_FACTOR = 0.75;
    /** Geometric score needed (with a complete time factor) to call it landed. */
    private static final double INFER_THRESHOLD = 0.5;
    /** Confirmation is a separate step, so inference never reaches certainty. */
    private static final double MAX_PROBABILITY = 0.97;

    // ---- After touchdown

    /** The parked estimate sits this fraction of the runway length past the threshold. */
    private static final double PARK_FRACTION = 1.0 / 3.0;
    private static final double MIN_LANDED_RADIUS_M = 500;
    /** Landed radius for a destination point with no runway geometry. */
    private static final double POINT_LANDED_RADIUS_M = 1_500;

    private static final double EARTH_RADIUS_M = 6_371_000;

    public GapEstimate estimate(GapInput in) {
        if (in == null || in.recent() == null || in.recent().isEmpty() || in.now() == null) {
            throw new IllegalArgumentException("estimate needs at least one recent point and now");
        }
        List<TrackPoint> pts = new ArrayList<>(in.recent());
        pts.sort(Comparator.comparing(TrackPoint::observedAt));
        TrackPoint last = pts.get(pts.size() - 1);
        double elapsedS = Math.max(0, Duration.between(last.observedAt(), in.now()).toMillis() / 1000.0);

        Double altitude = lastKnownAltitude(pts);
        double accelSigma = accelSigma(altitude);
        Filtered f = filter(pts, last, accelSigma);

        double p0Lat = last.lat() + Math.toDegrees(f.y.p / EARTH_RADIUS_M);
        double p0Lon = last.lon() + Math.toDegrees(f.x.p / (EARTH_RADIUS_M * Math.cos(Math.toRadians(last.lat()))));
        double speed = Math.hypot(f.x.v, f.y.v);
        Double trackDeg = null;
        if (speed >= MIN_TRACK_SPEED_MS) {
            trackDeg = normalize360(Math.toDegrees(Math.atan2(f.x.v, f.y.v)));
        } else if (last.trackDeg() != null) {
            trackDeg = normalize360(last.trackDeg());
        }
        Double vs = lastVerticalRate(pts);

        // Predicted covariance at "now" -> 95% radius
        Axis px = f.x.copy();
        Axis py = f.y.copy();
        px.predict(elapsedS, accelSigma * accelSigma);
        py.predict(elapsedS, accelSigma * accelSigma);
        double flightRadius = Math.max(MIN_RADIUS_M,
                RADIUS_SIGMA_FACTOR * Math.sqrt(Math.max(px.ppp, py.ppp)));

        Candidate cand = pickCandidate(in, p0Lat, p0Lon, trackDeg, vs);

        if (cand == null) {
            double dist = speed * elapsedS;
            double[] pos = trackDeg == null ? new double[]{p0Lat, p0Lon}
                    : destinationPoint(p0Lat, p0Lon, trackDeg, dist);
            ApproachGeometry g = new ApproachGeometry(null, vs, speed, null, null, null, null, null, null, null);
            return new GapEstimate(TrackState.COVERAGE_LOST, 0, 1, pos[0], pos[1], flightRadius,
                    in.now(), null, null, null, g, MODEL);
        }

        // ---- Time to touchdown
        Double height = altitude == null ? null : altitude - cand.elevationM;
        double dTouch = cand.distanceM + (cand.kind == Kind.ALIGNED ? TOUCHDOWN_ZONE_M : 0);
        double ttd = timeToTouchdown(dTouch, speed, height, vs);
        Instant touchdownAt = last.observedAt().plusMillis(Math.round(ttd * 1000));
        double margin = Math.max(MARGIN_MIN_S, MARGIN_RATIO * ttd);
        double timeFactor = clamp((elapsedS - ttd) / margin, 0, 1);

        // ---- Geometry and score
        double expectedHeight = cand.distanceM * Math.tan(Math.toRadians(GLIDE_SLOPE_DEG));
        Double glideDev = height == null ? null : height - expectedHeight;
        boolean goAround = goAroundSignature(pts, height);
        double geo = geometricScore(cand, height, vs, glideDev, expectedHeight, goAround, in);
        double probability = Math.min(MAX_PROBABILITY, geo * timeFactor);

        boolean landed = timeFactor >= 1 && geo > INFER_THRESHOLD;
        ApproachGeometry g = new ApproachGeometry(height, vs, speed, cand.distanceM,
                cand.crossTrackM, cand.headingDiffDeg, glideDev, goAround,
                cand.airportIcao, cand.ident);

        if (landed) {
            double[] park = cand.headingDeg != null && cand.lengthM != null
                    ? destinationPoint(cand.thrLat, cand.thrLon, cand.headingDeg, cand.lengthM * PARK_FRACTION)
                    : new double[]{cand.thrLat, cand.thrLon};
            double radius = cand.lengthM != null
                    ? Math.max(cand.lengthM / 2, MIN_LANDED_RADIUS_M) : POINT_LANDED_RADIUS_M;
            return new GapEstimate(TrackState.LANDED_INFERRED, probability, probability, park[0], park[1],
                    radius, in.now(), cand.airportIcao, cand.ident, touchdownAt, g, MODEL);
        }

        // Still in the air: dead-reckon, but an aircraft on final does not overfly its runway.
        double dist = speed * elapsedS;
        if (trackDeg != null) {
            double[] w = toXY(cand.thrLat, cand.thrLon, p0Lat, p0Lon);
            double tx = Math.sin(Math.toRadians(trackDeg));
            double ty = Math.cos(Math.toRadians(trackDeg));
            dist = Math.min(dist, Math.max(0, w[0] * tx + w[1] * ty));
        }
        double[] pos = trackDeg == null ? new double[]{p0Lat, p0Lon}
                : destinationPoint(p0Lat, p0Lon, trackDeg, dist);
        return new GapEstimate(TrackState.COVERAGE_LOST, probability, 1 - probability, pos[0], pos[1],
                flightRadius, in.now(), cand.airportIcao, cand.ident, touchdownAt, g, MODEL);
    }

    // ------------------------------------------------------------------ filter

    /** One axis of the filter: position and velocity with their 2x2 covariance. */
    private static final class Axis {
        double p, v, ppp, ppv, pvv;

        Axis copy() {
            Axis a = new Axis();
            a.p = p; a.v = v; a.ppp = ppp; a.ppv = ppv; a.pvv = pvv;
            return a;
        }

        /** Constant-velocity prediction with white-noise acceleration of variance q. */
        void predict(double dt, double q) {
            double nppp = ppp + 2 * dt * ppv + dt * dt * pvv + q * dt * dt * dt / 3;
            double nppv = ppv + dt * pvv + q * dt * dt / 2;
            double npvv = pvv + q * dt;
            p += v * dt;
            ppp = nppp; ppv = nppv; pvv = npvv;
        }

        void updatePosition(double z, double r) {
            double s = ppp + r;
            double k0 = ppp / s;
            double k1 = ppv / s;
            double y = z - p;
            p += k0 * y;
            v += k1 * y;
            double nppp = ppp - k0 * ppp;
            double nppv = ppv - k0 * ppv;
            double npvv = pvv - k1 * ppv;
            ppp = nppp; ppv = nppv; pvv = npvv;
        }

        void updateVelocity(double z, double r) {
            double s = pvv + r;
            double k0 = ppv / s;
            double k1 = pvv / s;
            double y = z - v;
            p += k0 * y;
            v += k1 * y;
            double nppp = ppp - k0 * ppv;
            double nppv = ppv - k0 * pvv;
            double npvv = pvv - k1 * pvv;
            ppp = nppp; ppv = nppv; pvv = npvv;
        }
    }

    private record Filtered(Axis x, Axis y) {
    }

    private static Filtered filter(List<TrackPoint> pts, TrackPoint origin, double accelSigma) {
        double q = accelSigma * accelSigma;
        Axis x = new Axis();
        Axis y = new Axis();
        TrackPoint first = pts.get(0);
        double[] xy = toXY(first.lat(), first.lon(), origin.lat(), origin.lon());
        x.p = xy[0];
        y.p = xy[1];
        x.ppp = y.ppp = POS_SIGMA_M * POS_SIGMA_M;
        if (hasVelocity(first)) {
            x.v = first.groundSpeedMs() * Math.sin(Math.toRadians(first.trackDeg()));
            y.v = first.groundSpeedMs() * Math.cos(Math.toRadians(first.trackDeg()));
            x.pvv = y.pvv = INIT_VEL_SIGMA_MS * INIT_VEL_SIGMA_MS;
        } else {
            x.pvv = y.pvv = INIT_VEL_UNKNOWN_SIGMA_MS * INIT_VEL_UNKNOWN_SIGMA_MS;
        }
        Instant t = first.observedAt();
        for (int i = 1; i < pts.size(); i++) {
            TrackPoint pt = pts.get(i);
            double dt = Duration.between(t, pt.observedAt()).toMillis() / 1000.0;
            if (dt <= 0.5) continue; // duplicate timestamp
            x.predict(dt, q);
            y.predict(dt, q);
            double[] z = toXY(pt.lat(), pt.lon(), origin.lat(), origin.lon());
            x.updatePosition(z[0], POS_SIGMA_M * POS_SIGMA_M);
            y.updatePosition(z[1], POS_SIGMA_M * POS_SIGMA_M);
            if (hasVelocity(pt)) {
                x.updateVelocity(pt.groundSpeedMs() * Math.sin(Math.toRadians(pt.trackDeg())),
                        VEL_SIGMA_MS * VEL_SIGMA_MS);
                y.updateVelocity(pt.groundSpeedMs() * Math.cos(Math.toRadians(pt.trackDeg())),
                        VEL_SIGMA_MS * VEL_SIGMA_MS);
            }
            t = pt.observedAt();
        }
        return new Filtered(x, y);
    }

    private static boolean hasVelocity(TrackPoint p) {
        return p.groundSpeedMs() != null && p.trackDeg() != null;
    }

    private static double accelSigma(Double altitude) {
        if (altitude == null || altitude <= ACCEL_LOW_ALT_M) return ACCEL_SIGMA_LOW_MS2;
        if (altitude >= ACCEL_CRUISE_ALT_M) return ACCEL_SIGMA_CRUISE_MS2;
        double f = (altitude - ACCEL_LOW_ALT_M) / (ACCEL_CRUISE_ALT_M - ACCEL_LOW_ALT_M);
        return ACCEL_SIGMA_LOW_MS2 + f * (ACCEL_SIGMA_CRUISE_MS2 - ACCEL_SIGMA_LOW_MS2);
    }

    // --------------------------------------------------------------- candidate

    private enum Kind { ALIGNED, DESTINATION_RUNWAY, DESTINATION_POINT }

    private static final class Candidate {
        Kind kind;
        String airportIcao;
        String ident;
        double thrLat, thrLon;
        Double headingDeg;
        Double lengthM;
        double elevationM;
        double distanceM;
        Double crossTrackM;
        Double headingDiffDeg;
        double rank;
    }

    private Candidate pickCandidate(GapInput in, double lat, double lon, Double trackDeg, Double vs) {
        List<Runway> runways = in.nearbyRunways() == null ? List.of() : in.nearbyRunways();
        Candidate best = null;
        if (trackDeg != null) {
            double tx = Math.sin(Math.toRadians(trackDeg));
            double ty = Math.cos(Math.toRadians(trackDeg));
            for (Runway r : runways) {
                double[] w = toXY(r.thresholdLat(), r.thresholdLon(), lat, lon);
                double ux = Math.sin(Math.toRadians(r.headingDeg()));
                double uy = Math.cos(Math.toRadians(r.headingDeg()));
                double along = w[0] * ux + w[1] * uy;          // > 0: aircraft is on the approach side
                double cross = w[1] * ux - w[0] * uy;          // aircraft offset, + right of centreline
                double hd = wrap180(trackDeg - r.headingDeg());
                boolean ahead = w[0] * tx + w[1] * ty > 0;
                if (!ahead || along <= 0 || along > MAX_APPROACH_DISTANCE_M) continue;
                if (Math.abs(hd) > MAX_HEADING_DIFF_DEG) continue;
                if (Math.abs(cross) > offsetLimit(along)) continue;
                double rank = 0.5 * (1 - Math.abs(hd) / MAX_HEADING_DIFF_DEG)
                        + 0.3 * Math.exp(-Math.abs(cross) / 500)
                        + 0.2 * (1 - along / MAX_APPROACH_DISTANCE_M)
                        + (matchesDestination(in, r) ? DESTINATION_RANK_BONUS : 0);
                if (best == null || rank > best.rank) {
                    best = fromRunway(Kind.ALIGNED, r, Math.hypot(w[0], w[1]), cross, hd);
                    best.rank = rank;
                }
            }
        }
        if (best != null) return best;
        return fallback(in, lat, lon, trackDeg, vs, runways);
    }

    /** No aligned runway: a descending aircraft within reach of its filed destination probably landed there. */
    private Candidate fallback(GapInput in, double lat, double lon, Double trackDeg, Double vs, List<Runway> runways) {
        boolean destinationKnown = in.destinationIcao() != null
                || (in.destinationLat() != null && in.destinationLon() != null);
        if (!destinationKnown || vs == null || vs > -FALLBACK_MIN_DESCENT_MS) return null;

        Candidate best = null;
        for (Runway r : runways) {
            if (!matchesDestination(in, r)) continue;
            double[] w = toXY(r.thresholdLat(), r.thresholdLon(), lat, lon);
            double d = Math.hypot(w[0], w[1]);
            if (d > FALLBACK_MAX_DISTANCE_M || !isAhead(w, trackDeg)) continue;
            if (best == null || d < best.distanceM) {
                double ux = Math.sin(Math.toRadians(r.headingDeg()));
                double uy = Math.cos(Math.toRadians(r.headingDeg()));
                Double hd = trackDeg == null ? null : wrap180(trackDeg - r.headingDeg());
                best = fromRunway(Kind.DESTINATION_RUNWAY, r, d, w[1] * ux - w[0] * uy, hd);
            }
        }
        if (best != null) return best;

        if (in.destinationLat() == null || in.destinationLon() == null) return null;
        double[] w = toXY(in.destinationLat(), in.destinationLon(), lat, lon);
        double d = Math.hypot(w[0], w[1]);
        if (d > FALLBACK_MAX_DISTANCE_M || !isAhead(w, trackDeg)) return null;
        Candidate c = new Candidate();
        c.kind = Kind.DESTINATION_POINT;
        c.airportIcao = in.destinationIcao();
        c.thrLat = in.destinationLat();
        c.thrLon = in.destinationLon();
        c.distanceM = d;
        return c;
    }

    private static Candidate fromRunway(Kind kind, Runway r, double distance, double cross, Double hd) {
        Candidate c = new Candidate();
        c.kind = kind;
        c.airportIcao = r.airportIcao();
        c.ident = r.ident();
        c.thrLat = r.thresholdLat();
        c.thrLon = r.thresholdLon();
        c.headingDeg = r.headingDeg();
        c.lengthM = r.lengthM();
        c.elevationM = r.elevationM() == null ? 0 : r.elevationM();
        c.distanceM = distance;
        c.crossTrackM = cross;
        c.headingDiffDeg = hd;
        return c;
    }

    private static boolean isAhead(double[] w, Double trackDeg) {
        if (trackDeg == null) return true;
        return w[0] * Math.sin(Math.toRadians(trackDeg)) + w[1] * Math.cos(Math.toRadians(trackDeg)) > 0;
    }

    private static double offsetLimit(double alongM) {
        return OFFSET_BASE_M + OFFSET_PER_DISTANCE * alongM;
    }

    /** Destination ICAO equals the runway's airport, or (no ICAO) the threshold is near the destination point. */
    private static boolean matchesDestination(GapInput in, Runway r) {
        if (in.destinationIcao() != null) return in.destinationIcao().equalsIgnoreCase(r.airportIcao());
        if (in.destinationLat() != null && in.destinationLon() != null) {
            return haversineM(r.thresholdLat(), r.thresholdLon(), in.destinationLat(), in.destinationLon())
                    <= DESTINATION_MATCH_RADIUS_M;
        }
        return false;
    }

    // ------------------------------------------------------------ touchdown time

    /**
     * Seconds from the last report to touchdown. Two estimates:
     * <ul>
     * <li>by distance: slow from the current speed to approach speed at a
     *     constant deceleration, then fly the rest at approach speed;</li>
     * <li>by height: height above the threshold over the current descent
     *     rate, only when descending faster than 1 m/s.</li>
     * </ul>
     * The aircraft cannot land before it reaches the runway, so the distance
     * time is the floor, and the later (more conservative) of the two wins
     * when the aircraft is high or shallow, since marking a plane landed
     * early is the costlier mistake. The height time is capped at 1.5x the
     * distance time so a shallow descent rate cannot push touchdown out
     * indefinitely.
     */
    private static double timeToTouchdown(double distanceM, double speedMs, Double height, Double vs) {
        double v = Math.max(speedMs, MIN_ETA_SPEED_MS);
        double tDist;
        if (v > APPROACH_SPEED_MS) {
            double tDec = (v - APPROACH_SPEED_MS) / APPROACH_DECEL_MS2;
            double dDec = (v + APPROACH_SPEED_MS) / 2 * tDec;
            if (distanceM <= dDec) {
                tDist = (v - Math.sqrt(v * v - 2 * APPROACH_DECEL_MS2 * distanceM)) / APPROACH_DECEL_MS2;
            } else {
                tDist = tDec + (distanceM - dDec) / APPROACH_SPEED_MS;
            }
        } else {
            tDist = distanceM / v;
        }
        if (vs != null && height != null && vs < -MIN_DESCENT_FOR_HEIGHT_MS && height > 0) {
            double tHeight = height / -vs;
            return Math.max(tDist, Math.min(tHeight, HEIGHT_TIME_MAX_RATIO * tDist));
        }
        return tDist;
    }

    // --------------------------------------------------------------------- score

    private static double geometricScore(Candidate c, Double height, Double vs, Double glideDev,
                                         double expectedHeight, boolean goAround, GapInput in) {
        double alignment;
        if (c.kind == Kind.ALIGNED) {
            alignment = 0.5 * (1 - Math.abs(c.headingDiffDeg) / MAX_HEADING_DIFF_DEG)
                    + 0.5 * Math.max(0, 1 - Math.abs(c.crossTrackM) / offsetLimit(c.distanceM));
        } else {
            alignment = FALLBACK_ALIGNMENT_SCORE;
        }
        double descent = vs == null ? UNKNOWN_SCORE
                : clamp((-vs - DESCENT_ZERO_MS) / (DESCENT_FULL_MS - DESCENT_ZERO_MS), 0, 1);
        if (height != null && height < FLARE_HEIGHT_M && vs != null && vs <= 0.5) {
            descent = Math.max(descent, 0.8);
        }
        double heightScore = height == null ? UNKNOWN_SCORE
                : clamp(1 - (Math.max(height, 0) - HEIGHT_FULL_M) / (HEIGHT_ZERO_M - HEIGHT_FULL_M), 0, 1);
        double glide = glideDev == null ? UNKNOWN_SCORE
                : Math.max(0, 1 - Math.abs(glideDev) / (150 + 0.3 * expectedHeight));
        boolean destinationKnown = in.destinationIcao() != null
                || (in.destinationLat() != null && in.destinationLon() != null);
        double destination = !destinationKnown ? DESTINATION_UNKNOWN_SCORE
                : (c.kind != Kind.ALIGNED || matchesCandidate(in, c) ? 1 : 0);

        double geo = W_ALIGNMENT * alignment + W_DESCENT * descent + W_HEIGHT * heightScore
                + W_GLIDE * glide + W_DESTINATION * destination;
        if (c.kind != Kind.ALIGNED) geo *= FALLBACK_FACTOR;

        if (height != null && height > CRUISE_HEIGHT_M) {
            geo *= CRUISE_FACTOR;
        } else if (goAround) {
            geo *= GO_AROUND_FACTOR;
        } else if (vs != null && vs > -DESCENT_ZERO_MS && (height == null || height >= FLARE_HEIGHT_M)) {
            geo *= LEVEL_FACTOR; // level or climbing at some height: not a landing
        }
        return clamp(geo, 0, 1);
    }

    private static boolean matchesCandidate(GapInput in, Candidate c) {
        if (in.destinationIcao() != null) return in.destinationIcao().equalsIgnoreCase(c.airportIcao);
        return haversineM(c.thrLat, c.thrLon, in.destinationLat(), in.destinationLon()) <= DESTINATION_MATCH_RADIUS_M;
    }

    /**
     * Go-around signature at low height: the aircraft descended earlier in
     * the window and is now climbing (&gt; +2 m/s, mean of the last two
     * rates), or it is accelerating (&gt; 0.3 m/s^2 over the last minute)
     * without descending.
     */
    private static boolean goAroundSignature(List<TrackPoint> pts, Double height) {
        if (height != null && height >= LOW_HEIGHT_M) return false;
        int n = pts.size();
        double[] rates = new double[n];
        boolean[] known = new boolean[n];
        for (int i = 0; i < n; i++) {
            TrackPoint p = pts.get(i);
            if (p.verticalRateMs() != null) {
                rates[i] = p.verticalRateMs();
                known[i] = true;
            } else if (i > 0 && p.altitudeM() != null && pts.get(i - 1).altitudeM() != null) {
                double dt = Duration.between(pts.get(i - 1).observedAt(), p.observedAt()).toMillis() / 1000.0;
                if (dt >= 5) {
                    rates[i] = (p.altitudeM() - pts.get(i - 1).altitudeM()) / dt;
                    known[i] = true;
                }
            }
        }
        double sum = 0;
        int count = 0;
        for (int i = n - 1; i >= 0 && count < 2; i--) {
            if (known[i]) { sum += rates[i]; count++; }
        }
        boolean climbingNow = count > 0 && sum / count > GO_AROUND_CLIMB_MS;
        if (climbingNow) {
            boolean descendedEarlier = false;
            for (int i = 0; i < n; i++) {
                if (known[i] && rates[i] < -GO_AROUND_DESCENT_MS) descendedEarlier = true;
                if (descendedEarlier && known[i] && rates[i] > GO_AROUND_CLIMB_MS) return true;
            }
        }
        // Accelerating over the last minute while not descending
        TrackPoint lastP = pts.get(n - 1);
        if (lastP.groundSpeedMs() != null && !(count > 0 && sum / count < -GO_AROUND_DESCENT_MS)) {
            for (int i = n - 2; i >= 0; i--) {
                TrackPoint p = pts.get(i);
                double dt = Duration.between(p.observedAt(), lastP.observedAt()).toMillis() / 1000.0;
                if (dt > GO_AROUND_WINDOW_S) break;
                if (p.groundSpeedMs() != null && dt >= 20
                        && (lastP.groundSpeedMs() - p.groundSpeedMs()) / dt > GO_AROUND_ACCEL_MS2) {
                    return true;
                }
            }
        }
        return false;
    }

    // -------------------------------------------------------------- kinematics

    private static Double lastKnownAltitude(List<TrackPoint> pts) {
        for (int i = pts.size() - 1; i >= 0; i--) {
            if (pts.get(i).altitudeM() != null) return pts.get(i).altitudeM();
        }
        return null;
    }

    /** The last reported vertical rate, else the slope between the last two altitudes at least 5 s apart. */
    private static Double lastVerticalRate(List<TrackPoint> pts) {
        TrackPoint last = pts.get(pts.size() - 1);
        if (last.verticalRateMs() != null) return last.verticalRateMs();
        if (last.altitudeM() == null) return null;
        for (int i = pts.size() - 2; i >= 0; i--) {
            TrackPoint p = pts.get(i);
            double dt = Duration.between(p.observedAt(), last.observedAt()).toMillis() / 1000.0;
            if (p.altitudeM() != null && dt >= 5) return (last.altitudeM() - p.altitudeM()) / dt;
        }
        return null;
    }

    // -------------------------------------------------------------------- geometry

    /** East/north metres of (lat, lon) in the tangent plane at (lat0, lon0). */
    private static double[] toXY(double lat, double lon, double lat0, double lon0) {
        double x = Math.toRadians(lon - lon0) * EARTH_RADIUS_M * Math.cos(Math.toRadians(lat0));
        double y = Math.toRadians(lat - lat0) * EARTH_RADIUS_M;
        return new double[]{x, y};
    }

    // Spherical direct geodesic problem, as in EstimatedPositionService.
    private static double[] destinationPoint(double latDeg, double lonDeg, double bearingDeg, double distanceM) {
        double phi1 = Math.toRadians(latDeg);
        double lambda1 = Math.toRadians(lonDeg);
        double theta = Math.toRadians(bearingDeg);
        double delta = distanceM / EARTH_RADIUS_M;
        double phi2 = Math.asin(Math.sin(phi1) * Math.cos(delta) + Math.cos(phi1) * Math.sin(delta) * Math.cos(theta));
        double lambda2 = lambda1 + Math.atan2(
                Math.sin(theta) * Math.sin(delta) * Math.cos(phi1),
                Math.cos(delta) - Math.sin(phi1) * Math.sin(phi2));
        double lon = ((Math.toDegrees(lambda2) + 540) % 360) - 180;
        return new double[]{Math.toDegrees(phi2), lon};
    }

    private static double haversineM(double lat1, double lon1, double lat2, double lon2) {
        double dLat = Math.toRadians(lat2 - lat1);
        double dLon = Math.toRadians(lon2 - lon1);
        double a = Math.sin(dLat / 2) * Math.sin(dLat / 2)
                + Math.cos(Math.toRadians(lat1)) * Math.cos(Math.toRadians(lat2))
                * Math.sin(dLon / 2) * Math.sin(dLon / 2);
        return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    private static double wrap180(double deg) {
        return ((deg + 180) % 360 + 360) % 360 - 180;
    }

    private static double normalize360(double deg) {
        return ((deg % 360) + 360) % 360;
    }

    private static double clamp(double v, double lo, double hi) {
        return Math.max(lo, Math.min(hi, v));
    }
}
