package com.flighttracker.controller;

import com.flighttracker.dto.Bounds;
import org.springframework.web.bind.annotation.RequestParam;

import java.util.Optional;
import java.util.stream.Stream;

/** /api/flights/live's optional viewport: a bbox only when all four query parameters are given. */
public record ViewportParams(@RequestParam(required = false) Double latMin,
                             @RequestParam(required = false) Double latMax,
                             @RequestParam(required = false) Double lonMin,
                             @RequestParam(required = false) Double lonMax) {

    Optional<Bounds> bounds() {
        if (Stream.of(latMin, latMax, lonMin, lonMax).anyMatch(v -> v == null)) return Optional.empty();
        return Optional.of(new Bounds(latMin, latMax, lonMin, lonMax));
    }
}
