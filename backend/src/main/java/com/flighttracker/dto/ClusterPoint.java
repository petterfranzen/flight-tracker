package com.flighttracker.dto;

/**
 * One grid cell's worth of aggregated live traffic — the zoomed-way-out
 * answer to "how many aircraft, roughly where" instead of "every aircraft,
 * exactly where". Spring Data's native-query interface projection maps
 * this straight from the query's column aliases (lat/lon/count), so no
 * manual row mapping is needed — see FlightPositionRepository.findLiveClusteredInBounds.
 */
public interface ClusterPoint {
    double getLat();
    double getLon();
    long getCount();
}
