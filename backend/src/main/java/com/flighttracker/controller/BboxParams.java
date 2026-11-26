package com.flighttracker.controller;

import com.flighttracker.dto.Bounds;
import org.springframework.web.bind.annotation.RequestParam;

/** The required viewport query parameters of the zoomed-out /api/flights endpoints. */
public record BboxParams(@RequestParam double latMin,
                         @RequestParam double latMax,
                         @RequestParam double lonMin,
                         @RequestParam double lonMax) {

    Bounds bounds() {
        return new Bounds(latMin, latMax, lonMin, lonMax);
    }
}
