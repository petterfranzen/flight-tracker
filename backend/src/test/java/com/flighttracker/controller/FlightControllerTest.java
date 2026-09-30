package com.flighttracker.controller;

import com.flighttracker.model.Aircraft;
import com.flighttracker.model.Airport;
import com.flighttracker.model.FlightPosition;
import com.flighttracker.repository.AircraftRepository;
import com.flighttracker.repository.FlightPositionRepository;
import com.flighttracker.service.ViewportService;
import com.flighttracker.service.enrichment.AirportLookupService;
import com.flighttracker.service.live.LiveAircraft;
import com.flighttracker.service.live.LiveStateStore;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.time.Instant;
import java.util.List;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

/**
 * No DB, no Spring context — LiveStateStore/ViewportService/
 * AircraftRepository/AirportLookupService are mocked, and FlightController
 * is constructed directly. Covers /search's branching (airport takes over
 * from q entirely) and the airport-pattern matching FlightController now
 * does itself in Java (ported from FlightPositionRepository.searchByAirport's
 * SQL join — see that method's own javadoc). LiveStateStore's own SQL-free
 * in-memory reads (bbox/clustered/count/callsign search) are covered by
 * LiveStateStoreTest instead.
 */
@ExtendWith(MockitoExtension.class)
class FlightControllerTest {

    @Mock
    private LiveStateStore liveStateStore;
    @Mock
    private FlightPositionRepository positionRepository;
    @Mock
    private ViewportService viewportService;
    @Mock
    private AircraftRepository aircraftRepository;
    @Mock
    private AirportLookupService airportLookupService;

    private FlightController controller() {
        return new FlightController(liveStateStore, positionRepository, viewportService, aircraftRepository, airportLookupService);
    }

    // LiveAircraft has no public constructor test helper of its own (it's a
    // plain record) — this just fills every field with an innocuous default
    // except the ones a given test cares about.
    private static LiveAircraft live(String icao24, String callsign) {
        Instant now = Instant.now();
        return new LiveAircraft(1L, icao24, callsign, now, 59.0, 18.0,
                null, null, null, null, false, "opensky", null, null, null, null);
    }

    private static Aircraft aircraftWithRoute(String icao24, String originAirport, String originAirportName,
                                               String destinationAirport, String destinationAirportName) {
        Aircraft a = new Aircraft(icao24);
        a.setOriginAirport(originAirport);
        a.setOriginAirportName(originAirportName);
        a.setDestinationAirport(destinationAirport);
        a.setDestinationAirportName(destinationAirportName);
        return a;
    }

    @Test
    void airportNonBlank_matchesByCachedOriginAirportName_ignoringQEvenIfPresent() {
        when(liveStateStore.liveAircraft(any(), any())).thenReturn(List.of(live("abc123", "SAS100")));
        when(aircraftRepository.findAllById(List.of("abc123")))
                .thenReturn(List.of(aircraftWithRoute("abc123", "ESSA", "Stockholm Arlanda", "EGLL", null)));
        // No airportLookupService stub needed: the cached originAirportName
        // ("Stockholm Arlanda") already matches, short-circuiting before
        // the airport reference table lookup is ever reached.

        List<FlightPosition> result = controller().search("SAS123", "Arlanda");

        assertThat(result).extracting(FlightPosition::getIcao24).containsExactly("abc123");
        verify(liveStateStore, never()).searchByCallsign(any(), any(), any(), anyInt());
    }

    @Test
    void airportNonBlank_matchesByAirportReferenceTable_caseInsensitive() {
        when(liveStateStore.liveAircraft(any(), any())).thenReturn(List.of(live("abc123", "SAS100")));
        when(aircraftRepository.findAllById(List.of("abc123")))
                .thenReturn(List.of(aircraftWithRoute("abc123", "ESSA", null, "EGLL", null)));
        Airport arlanda = mock(Airport.class);
        when(arlanda.getIataCode()).thenReturn("ARN");
        when(arlanda.getName()).thenReturn("Stockholm Arlanda Airport");
        // getMunicipality() and the destination (EGLL) lookup are never
        // reached — the origin's name already matches, short-circuiting
        // the rest of matchesAirportPattern's OR chain.
        when(airportLookupService.lookup("ESSA")).thenReturn(Optional.of(arlanda));

        List<FlightPosition> result = controller().search(null, "arlanda"); // lowercase, table has mixed case

        assertThat(result).extracting(FlightPosition::getIcao24).containsExactly("abc123");
    }

    @Test
    void airportNonBlank_noMatch_returnsEmpty() {
        when(liveStateStore.liveAircraft(any(), any())).thenReturn(List.of(live("abc123", "SAS100")));
        when(aircraftRepository.findAllById(List.of("abc123")))
                .thenReturn(List.of(aircraftWithRoute("abc123", "ESSA", "Stockholm Arlanda", "EGLL", "London Heathrow")));
        when(airportLookupService.lookup(any())).thenReturn(Optional.empty());

        List<FlightPosition> result = controller().search(null, "Narita");

        assertThat(result).isEmpty();
    }

    @Test
    void airportBlank_fallsBackToCallsignSearchWithTrimmedQ() {
        when(liveStateStore.searchByCallsign(eq("SAS"), any(), any(), eq(8))).thenReturn(List.of());

        controller().search("  SAS  ", "  ");

        verify(liveStateStore).searchByCallsign(eq("SAS"), any(), any(), eq(8));
        verify(liveStateStore, never()).liveAircraft(any(), any());
    }

    @Test
    void allBlank_returnsEmptyListWithoutCallingStore() {
        List<FlightPosition> result = controller().search(null, null);

        assertThat(result).isEmpty();
        verifyNoInteractions(liveStateStore);
    }

    @Test
    void qWithSpecialCharacters_passedThroughLiterally_noLikeEscapingNeeded() {
        // Now that this is a plain Java substring match rather than a SQL
        // LIKE pattern, a literal %/_/\\ needs no escaping — the exact
        // trimmed string reaches LiveStateStore.searchByCallsign as-is.
        when(liveStateStore.searchByCallsign(eq("50%"), any(), any(), eq(8))).thenReturn(List.of());

        controller().search("50%", null);

        verify(liveStateStore).searchByCallsign(eq("50%"), any(), any(), eq(8));
    }
}
