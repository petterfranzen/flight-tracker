package com.flighttracker.controller;

import com.flighttracker.dto.AircraftDossier;
import com.flighttracker.model.Aircraft;
import com.flighttracker.repository.AircraftRepository;
import com.flighttracker.repository.FlightPositionRepository;
import com.flighttracker.service.enrichment.AircraftEnrichmentService;
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
    private final FlightPositionRepository positionRepository;
    private final AircraftEnrichmentService enrichmentService;

    public AircraftController(AircraftRepository aircraftRepository,
                               FlightPositionRepository positionRepository,
                               AircraftEnrichmentService enrichmentService) {
        this.aircraftRepository = aircraftRepository;
        this.positionRepository = positionRepository;
        this.enrichmentService = enrichmentService;
    }

    /**
     * Dossier fields (type/registration/operator/origin/destination) for one
     * aircraft. Aircraft the "agent" container's hot poll sees get enriched
     * eagerly and asynchronously (AgentOrchestrator.pollAll); aircraft only
     * the global sweep has found are never eagerly enriched (that would mean
     * enriching several thousand aircraft nobody's looking at every sweep —
     * see AgentOrchestrator.pollGlobalSweep for why that doesn't scale), so
     * this does it lazily and synchronously right here instead, the moment
     * someone actually asks. That means this request can take a bit longer
     * than a typical GET the first time a given aircraft's dossier is
     * opened — acceptable for a single user-initiated lookup, unlike the
     * bulk case this deliberately avoids.
     */
    @GetMapping("/{icao24}")
    public ResponseEntity<AircraftDossier> get(@PathVariable String icao24) {
        Aircraft aircraft = aircraftRepository.findById(icao24).orElse(null);
        if (aircraft == null) return ResponseEntity.notFound().build();

        if (aircraft.getMetadataFetchedAt() == null) {
            String callsign = positionRepository.findLatestCallsign(icao24).orElse(null);
            enrichmentService.enrichSynchronously(icao24, callsign);
            aircraft = aircraftRepository.findById(icao24).orElse(aircraft);
        }

        return ResponseEntity.ok(toDossier(aircraft));
    }

    private static AircraftDossier toDossier(Aircraft a) {
        return new AircraftDossier(
                a.getIcao24(), a.getRegistration(), a.getModel(), a.getOperator(),
                a.getOriginAirport(), a.getOriginAirportName(),
                a.getDestinationAirport(), a.getDestinationAirportName());
    }
}
