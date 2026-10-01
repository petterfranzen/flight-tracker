package com.flighttracker.service.live;

import com.flighttracker.dto.ClusterPoint;

/** Concrete ClusterPoint — see LiveMarkerView's javadoc for why this exists (same reasoning, different projection). */
final class ClusterPointView implements ClusterPoint {

    private final double lat;
    private final double lon;
    private final long count;

    ClusterPointView(double lat, double lon, long count) {
        this.lat = lat;
        this.lon = lon;
        this.count = count;
    }

    @Override
    public double getLat() { return lat; }

    @Override
    public double getLon() { return lon; }

    @Override
    public long getCount() { return count; }
}
