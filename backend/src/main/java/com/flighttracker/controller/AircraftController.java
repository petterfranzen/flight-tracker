package com.flighttracker.controller;

import com.flighttracker.dto.AircraftDossier;
import com.flighttracker.model.Aircraft;
import com.flighttracker.repository.AircraftRepository;
import org.springframework.context.annotation.Profile;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/aircraft")
@Profile("api")
public class AircraftController {

    private final AircraftRepository aircraftRepository;

    public AircraftController(AircraftRepository aircraftRepository) {
        this.aircraftRepository = aircraftRepository;
    }

    /**
     * Dossier fields (type/registration/operator/origin/destination) for one
     * aircraft. These are filled in asynchronously the first time the
     * poller sees a given icao24 (see AircraftEnrichmentService), so a
     * freshly-seen aircraft may briefly show nulls here before that
     * lookup completes.
     */
    @GetMapping("/{icao24}")
    public ResponseEntity<AircraftDossier> get(@PathVariable String icao24) {
        return aircraftRepository.findById(icao24)
                .map(AircraftController::toDossier)
                .map(ResponseEntity::ok)
                .orElseGet(() -> ResponseEntity.notFound().build());
    }

    private static AircraftDossier toDossier(Aircraft a) {
        return new AircraftDossier(
                a.getIcao24(), a.getRegistration(), a.getModel(), a.getOperator(),
                a.getOriginAirport(), a.getOriginAirportName(),
                a.getDestinationAirport(), a.getDestinationAirportName());
    }
}
