package com.flighttracker.controller;

import com.flighttracker.dto.AircraftDossier;
import com.flighttracker.model.Aircraft;
import com.flighttracker.repository.AircraftRepository;
import com.flighttracker.repository.FlightPositionRepository;
import com.flighttracker.service.confirmation.ConfirmationStore;
import com.flighttracker.service.enrichment.AircraftEnrichmentService;
import com.flighttracker.service.enrichment.AirportLookupService;
import com.flighttracker.service.live.LiveStateStore;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.http.ResponseEntity;

import java.time.Clock;
import java.time.Instant;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class AircraftControllerTest {

    @Mock
    private AircraftRepository aircraftRepository;
    @Mock
    private FlightPositionRepository positionRepository;
    @Mock
    private LiveStateStore liveStateStore;
    @Mock
    private AircraftEnrichmentService enrichmentService;
    @Mock
    private AirportLookupService airportLookupService;

    private AircraftController controller() {
        return new AircraftController(aircraftRepository, positionRepository, liveStateStore, enrichmentService,
                airportLookupService, new ConfirmationStore(120, 100), Clock.systemUTC());
    }

    @Test
    void upperCaseIcao24_findsTheSameAircraft() {
        Instant now = Instant.now();
        Aircraft stored = new Aircraft("4aab14", "SE-RUA", "A320", "SAS", null, null, null, null,
                null, null, null, null, now, null, null, now, now);
        when(aircraftRepository.findById("4aab14")).thenReturn(Optional.of(stored));

        ResponseEntity<AircraftDossier> response = controller().get(" 4AAB14 ");

        assertThat(response.getStatusCode().is2xxSuccessful()).isTrue();
        assertThat(response.getBody().icao24()).isEqualTo("4aab14");
    }
}
