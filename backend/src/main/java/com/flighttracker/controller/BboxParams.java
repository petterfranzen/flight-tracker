package com.flighttracker.controller;

import com.flighttracker.dto.Bounds;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.server.ResponseStatusException;

/** The required viewport query parameters of the zoomed-out /api/flights endpoints. */
public record BboxParams(@RequestParam double latMin,
                         @RequestParam double latMax,
                         @RequestParam double lonMin,
                         @RequestParam double lonMax) {

    Bounds bounds() {
        return requireFinite(new Bounds(latMin, latMax, lonMin, lonMax));
    }

    /**
     * A bbox edge of {@code NaN} or {@code Infinity} parses as a double but bounds
     * nothing, so it is a {@code 400} like any other malformed bbox. Ranges are not
     * checked: the map can report a longitude past ±180 after panning across the
     * antimeridian, and that has always been answered.
     */
    static Bounds requireFinite(Bounds bounds) {
        if (!bounds.isFinite()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "bbox edges must be finite numbers");
        }
        return bounds;
    }
}
