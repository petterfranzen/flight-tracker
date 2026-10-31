package com.flighttracker.controller;

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

import java.time.Clock;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/** No DB, no Spring context: AircraftController is constructed directly over mocks. */
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
    private final ConfirmationStore confirmationStore = new ConfirmationStore(120, 100);

    private AircraftController controller() {
        return new AircraftController(aircraftRepository, positionRepository, liveStateStore,
                enrichmentService, airportLookupService, confirmationStore, Clock.systemUTC());
    }

    @Test
    void get_mixedCaseIcao24_isLookedUpLowerCase() {
        when(aircraftRepository.findById("4aab14")).thenReturn(Optional.empty());

        assertThat(controller().get("4AAB14").getStatusCode().value()).isEqualTo(404);
        verify(aircraftRepository).findById("4aab14");
    }
}
