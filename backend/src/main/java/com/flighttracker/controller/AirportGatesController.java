package com.flighttracker.controller;

import com.flighttracker.dto.AirportInfo;
import com.flighttracker.model.Airport;
import com.flighttracker.repository.AirportRepository;
import com.flighttracker.service.enrichment.OverpassAirportGatesClient;
import com.flighttracker.service.enrichment.OverpassAirportGatesClient.AirportGateFeature;
import org.springframework.context.annotation.Profile;
import org.springframework.http.ResponseEntity;
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
    private final AirportRepository airportRepository;

    public AirportGatesController(OverpassAirportGatesClient gatesClient, AirportRepository airportRepository) {
        this.gatesClient = gatesClient;
        this.airportRepository = airportRepository;
    }

    /**
     * Static name/municipality/country for the map's airport dossier panel
     * — looked up by IATA code since that's what VectorBasemap's own
     * airport data (WORLD_AIRPORTS, from Natural Earth) keys everything
     * by, not the icao_code the `airport` table otherwise uses as its id.
     * 404 for a code with no reference-table match, same convention as
     * AircraftController's own by-icao24 lookups.
     */
    @GetMapping("/info")
    public ResponseEntity<AirportInfo> info(@RequestParam String code) {
        return airportRepository.findByIataCode(code)
                .map(AirportGatesController::toInfo)
                .map(ResponseEntity::ok)
                .orElseGet(() -> ResponseEntity.notFound().build());
    }

    private static AirportInfo toInfo(Airport a) {
        return new AirportInfo(a.getIcaoCode(), a.getIataCode(), a.getName(), a.getMunicipality(), a.getCountry(), a.getLatitude(), a.getLongitude());
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
