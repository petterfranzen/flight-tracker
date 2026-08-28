package com.flighttracker.dto;

/** A lat/lon bounding box — the current map viewport, or a query filter. */
public record Bounds(double latMin, double latMax, double lonMin, double lonMax) {

    public boolean contains(double latitude, double longitude) {
        return latitude >= latMin && latitude <= latMax && longitude >= lonMin && longitude <= lonMax;
    }
}
