package com.flighttracker.controller;

import com.flighttracker.dto.GeoPoint;
import com.flighttracker.service.GeoLocator;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * The visitor's approximate location, so the map can open near them instead of
 * always on the same view (see GeoLocator for where it comes from). 204 when
 * there is nothing usable (local dev, no Cloudflare headers): the frontend
 * then keeps its default view. Never cached (it is per visitor), never stored.
 */
@RestController
@RequestMapping("/api/geo")
public class GeoController {

    @GetMapping
    public ResponseEntity<GeoPoint> geo(HttpServletRequest request) {
        return GeoLocator.fromHeaders(request::getHeader)
                .map(p -> ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(p))
                .orElseGet(() -> ResponseEntity.noContent().cacheControl(CacheControl.noStore()).build());
    }
}
