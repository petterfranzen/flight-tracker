package com.flighttracker.controller;

import com.flighttracker.service.enrichment.OverpassAirportGatesClient;
import com.flighttracker.service.enrichment.OverpassAirportGatesClient.AirportGateFeature;
import org.springframework.context.annotation.Profile;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

@RestController
@RequestMapping("/api/airports")
@Profile("api")
public class AirportGatesController {

    private final OverpassAirportGatesClient gatesClient;

    public AirportGatesController(OverpassAirportGatesClient gatesClient) {
        this.gatesClient = gatesClient;
    }

    /**
     * Real terminal/apron/hangar/gate geometry for one airport, fetched
     * from OpenStreetMap via Overpass (see OverpassAirportGatesClient) —
     * VectorBasemap.tsx only calls this once zoomed in close enough on a
     * specific airport to actually see this level of detail, and caches
     * the result client-side too, on top of this endpoint's own server-
     * side cache.
     */
    @GetMapping("/gates")
    public List<AirportGateFeature> gates(@RequestParam String code,
                                           @RequestParam double lat,
                                           @RequestParam double lon) {
        return gatesClient.fetchGates(code, lat, lon);
    }
}
