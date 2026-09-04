package com.flighttracker.controller;

import com.flighttracker.dto.AirportInfo;
import com.flighttracker.model.Airport;
import com.flighttracker.repository.AirportRepository;
import org.springframework.context.annotation.Profile;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * Was AirportGatesController. It also served /api/airports/gates, which
 * proxied live Overpass queries for one airport's terminal/apron/hangar/
 * gate geometry, because no bundled dataset carried airport layouts and
 * the map's canvas renderer had nothing to draw at close zoom without it.
 * That endpoint and its OverpassAirportGatesClient are gone: the map now
 * renders vector tiles whose `aeroway` layer already carries apron,
 * runway, taxiway and gate geometry for every airport on earth, so the
 * layout is simply present the moment it's in view — no request, no
 * multi-second wait on a shared public Overpass instance, and no cache to
 * keep. See cyberpunkMapStyle.ts.
 */
@RestController
@RequestMapping("/api/airports")
@Profile("api")
public class AirportController {

    private final AirportRepository airportRepository;

    public AirportController(AirportRepository airportRepository) {
        this.airportRepository = airportRepository;
    }

    /**
     * Static name/municipality/country for the map's airport dossier panel
     * — looked up by IATA code since that's what the map's own bundled
     * airport data (AIRPORTS, from Natural Earth) keys everything by, not
     * the icao_code the `airport` table otherwise uses as its id. 404 for a
     * code with no reference-table match, same convention as
     * AircraftController's own by-icao24 lookups.
     */
    @GetMapping("/info")
    public ResponseEntity<AirportInfo> info(@RequestParam String code) {
        return airportRepository.findByIataCode(code)
                .map(AirportController::toInfo)
                .map(ResponseEntity::ok)
                .orElseGet(() -> ResponseEntity.notFound().build());
    }

    private static AirportInfo toInfo(Airport a) {
        return new AirportInfo(a.getIcaoCode(), a.getIataCode(), a.getName(), a.getMunicipality(), a.getCountry(), a.getLatitude(), a.getLongitude());
    }
}
