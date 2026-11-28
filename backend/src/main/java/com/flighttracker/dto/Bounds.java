package com.flighttracker.dto;

import java.util.stream.DoubleStream;

/** A lat/lon bounding box — the current map viewport, or a query filter. */
public record Bounds(double latMin, double latMax, double lonMin, double lonMax) {

    public boolean contains(double latitude, double longitude) {
        return latitude >= latMin && latitude <= latMax && longitude >= lonMin && longitude <= lonMax;
    }

    /** True when every edge is a real number; a NaN or infinite edge bounds nothing. */
    public boolean isFinite() {
        return DoubleStream.of(latMin, latMax, lonMin, lonMax).allMatch(Double::isFinite);
    }
}
