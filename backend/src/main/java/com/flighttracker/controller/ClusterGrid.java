package com.flighttracker.controller;

/** The cluster grid cell size, in degrees, that the zoomed-out /api/flights endpoints accept. */
final class ClusterGrid {

    // Below this, a grid cell would be finer than markers are distinguishable
    // at anyway, so there's nothing to gain over just returning individual
    // positions — and above it a client-requested finer grid would just
    // shift the "too many rows/markers" problem from aircraft to cells.
    // 25° covers the frontend's actual worst case (minZoom=2 asks for
    // ~22.5°, sized off screen pixel spacing — see gridDegForZoom in
    // FlightMap.tsx) with a little headroom, rather than silently clamping
    // it down and re-introducing the overlapping-cluster crowding that
    // sizing was specifically computed to avoid.
    private static final double MIN_DEG = 0.5;
    private static final double MAX_DEG = 40;

    private ClusterGrid() {
    }

    static double clamp(double gridDeg) {
        return Math.min(MAX_DEG, Math.max(MIN_DEG, gridDeg));
    }
}
