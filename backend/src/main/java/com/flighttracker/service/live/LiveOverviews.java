package com.flighttracker.service.live;

import com.flighttracker.dto.ClusterPoint;
import com.flighttracker.dto.LiveMarker;
import com.flighttracker.dto.LiveOverview;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Function;

/**
 * The zoomed-out map shapes {@link LiveStateStore} answers with (clusters,
 * overview, discovered), computed from a snapshot list of active aircraft it
 * has already taken from its map. Pure functions: no shared state.
 */
final class LiveOverviews {

    /** How many planes the overview may draw: at most {@code maxPlanes}, {@code perCell} per {@code gridDeg} cell. */
    record PlaneAllowance(double gridDeg, int maxPlanes, int perCell) {
    }

    /** Fastest airborne first (unknown speed counts as -1), newest report as the tie-break, then icao24. */
    private static final Comparator<LiveAircraft> MOST_ACTIVE_FIRST = (a, b) -> {
        double va = a.velocityMs() != null ? a.velocityMs() : -1;
        double vb = b.velocityMs() != null ? b.velocityMs() : -1;
        if (va != vb) return Double.compare(vb, va);
        int byRecency = b.observedAt().compareTo(a.observedAt());
        return byRecency != 0 ? byRecency : a.icao24().compareTo(b.icao24());
    };

    private LiveOverviews() {
    }

    /** Groups aircraft into {@code gridDeg} cells; each cluster sits at the mean position of its members. */
    static List<ClusterPoint> bucket(List<LiveAircraft> aircraft, double gridDeg) {
        record BucketKey(double lat, double lon) { }
        final class Sum {
            long count;
            double lat;
            double lon;
        }
        Map<BucketKey, Sum> cells = new HashMap<>();
        for (LiveAircraft a : aircraft) {
            double lat = a.displayLatitude();
            double lon = a.displayLongitude();
            double bucketLat = Math.floor(lat / gridDeg) * gridDeg;
            double bucketLon = Math.floor(lon / gridDeg) * gridDeg;
            Sum sum = cells.computeIfAbsent(new BucketKey(bucketLat, bucketLon), k -> new Sum());
            sum.count++;
            sum.lat += lat;
            sum.lon += lon;
        }
        List<ClusterPoint> out = new ArrayList<>(cells.size());
        for (Sum sum : cells.values()) {
            out.add(new ClusterPointView(sum.lat / sum.count, sum.lon / sum.count, sum.count));
        }
        return out;
    }

    /** See {@link LiveStateStore#overview}. Sorts {@code active} in place. */
    static LiveOverview overview(List<LiveAircraft> active, PlaneAllowance allowance,
                                 Function<LiveAircraft, LiveMarker> marker) {
        active.sort(MOST_ACTIVE_FIRST);
        List<LiveMarker> planes = new ArrayList<>();
        List<LiveAircraft> rest = new ArrayList<>();
        Map<String, Integer> perCellTaken = new HashMap<>();
        for (LiveAircraft a : active) {
            String cell = cellKey(a, allowance.gridDeg());
            int taken = perCellTaken.getOrDefault(cell, 0);
            if (planes.size() < allowance.maxPlanes() && taken < allowance.perCell()) {
                perCellTaken.put(cell, taken + 1);
                planes.add(marker.apply(a));
            } else {
                rest.add(a);
            }
        }
        return new LiveOverview(planes, bucket(rest, allowance.gridDeg()));
    }

    /** See {@link LiveStateStore#discovered}. Sorts {@code active} in place. */
    static LiveOverview discovered(List<LiveAircraft> active, double cellDeg, int maxPlanes,
                                   Function<LiveAircraft, LiveMarker> marker) {
        active.sort((a, b) -> Long.compare(a.id(), b.id()));
        List<LiveMarker> planes = new ArrayList<>();
        Set<String> taken = new HashSet<>();
        for (LiveAircraft a : active) {
            if (planes.size() >= maxPlanes) break;
            if (taken.add(cellKey(a, cellDeg))) planes.add(marker.apply(a));
        }
        return new LiveOverview(planes, List.of());
    }

    private static String cellKey(LiveAircraft a, double cellDeg) {
        return Math.floor(a.displayLatitude() / cellDeg) + "," + Math.floor(a.displayLongitude() / cellDeg);
    }
}
