package com.flighttracker.service.coverage;

import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.Collection;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * In-memory index of every runway direction (see {@link Runway}), bucketed
 * in a lat/lon grid so "which runways are near this point" doesn't scan the
 * ~16k rows. Rebuilt wholesale by {@link RunwaySeedService}: readers always
 * see one immutable {@link Snapshot}, swapped through a volatile field, so
 * there is no locking and no half-built state.
 */
@Component
public class RunwayIndex {

    static final double CELL_DEG = 0.5;
    private static final int LAT_CELLS = (int) (180 / CELL_DEG);
    private static final int LON_CELLS = (int) (360 / CELL_DEG);
    private static final double EARTH_RADIUS_M = 6_371_008.8;
    private static final double M_PER_DEG_LAT = Math.PI * EARTH_RADIUS_M / 180.0;

    private volatile Snapshot snapshot = new Snapshot(Map.of(), Map.of());

    /** Replaces the whole index; safe to call while other threads read. */
    public void replace(Collection<Runway> runways) {
        Map<Long, List<Runway>> cells = new HashMap<>();
        Map<String, List<Runway>> byAirport = new HashMap<>();
        for (Runway r : runways) {
            cells.computeIfAbsent(cellKey(latCell(r.thresholdLat()), lonCell(r.thresholdLon())),
                    k -> new ArrayList<>()).add(r);
            byAirport.computeIfAbsent(r.airportIcao(), k -> new ArrayList<>()).add(r);
        }
        cells.replaceAll((k, v) -> List.copyOf(v));
        byAirport.replaceAll((k, v) -> List.copyOf(v));
        snapshot = new Snapshot(Map.copyOf(cells), Map.copyOf(byAirport));
    }

    /** Runways whose threshold is within {@code radiusM} of the point, nearest first. */
    public List<Runway> near(double lat, double lon, double radiusM) {
        Snapshot s = snapshot;
        double dLat = radiusM / M_PER_DEG_LAT;
        int latLo = Math.max(0, latCell(lat - dLat));
        int latHi = Math.min(LAT_CELLS - 1, latCell(lat + dLat));

        // Degrees of longitude shrink with latitude; at the pole-ward edge of
        // the search box a degree of longitude is the shortest, so use that.
        // A circle that reaches a pole spans every longitude.
        double edgeLat = Math.abs(lat) + dLat;
        double dLon = edgeLat >= 89.9 ? 180
                : radiusM / (M_PER_DEG_LAT * Math.cos(Math.toRadians(edgeLat)));
        int lonSpan = dLon >= 180 ? LON_CELLS
                : Math.min(LON_CELLS, rawLonCell(lon + dLon) - rawLonCell(lon - dLon) + 1);
        int lonStart = rawLonCell(lon - dLon);

        record Hit(Runway runway, double distM) {
        }
        List<Hit> hits = new ArrayList<>();
        for (int la = latLo; la <= latHi; la++) {
            for (int i = 0; i < lonSpan; i++) {
                List<Runway> cell = s.cells.get(cellKey(la, Math.floorMod(lonStart + i, LON_CELLS)));
                if (cell == null) continue;
                for (Runway r : cell) {
                    double d = distanceM(lat, lon, r.thresholdLat(), r.thresholdLon());
                    if (d <= radiusM) hits.add(new Hit(r, d));
                }
            }
        }
        hits.sort(Comparator.comparingDouble(Hit::distM));
        return hits.stream().map(Hit::runway).toList();
    }

    /** Every runway direction at the airport (ICAO code), empty if unknown. */
    public List<Runway> atAirport(String icao) {
        return snapshot.byAirport.getOrDefault(icao, List.of());
    }

    public int size() {
        return snapshot.cells.values().stream().mapToInt(List::size).sum();
    }

    private static int latCell(double lat) {
        int cell = (int) Math.floor((lat + 90) / CELL_DEG);
        return Math.max(0, Math.min(LAT_CELLS - 1, cell));
    }

    // Unwrapped (may be negative or past the last cell); callers wrap it.
    private static int rawLonCell(double lon) {
        return (int) Math.floor((lon + 180) / CELL_DEG);
    }

    private static int lonCell(double lon) {
        return Math.floorMod(rawLonCell(lon), LON_CELLS);
    }

    private static long cellKey(int latCell, int lonCell) {
        return (long) latCell * LON_CELLS + lonCell;
    }

    static double distanceM(double lat1, double lon1, double lat2, double lon2) {
        double p1 = Math.toRadians(lat1), p2 = Math.toRadians(lat2);
        double dp = p2 - p1, dl = Math.toRadians(lon2 - lon1);
        double a = Math.sin(dp / 2) * Math.sin(dp / 2)
                + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) * Math.sin(dl / 2);
        return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1.0, Math.sqrt(a)));
    }

    private record Snapshot(Map<Long, List<Runway>> cells, Map<String, List<Runway>> byAirport) {
    }
}
