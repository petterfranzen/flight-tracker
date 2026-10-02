package com.flighttracker.controller;

import com.flighttracker.dto.LiveOverview;
import com.flighttracker.model.FlightPosition;
import com.flighttracker.repository.AirportRepository;
import com.flighttracker.repository.FlightPositionRepository;
import com.flighttracker.service.ViewportService;
import com.flighttracker.service.enrichment.AircraftEnrichmentService;
import com.flighttracker.service.enrichment.Route;
import com.flighttracker.service.live.LiveAircraft;
import com.flighttracker.service.live.LiveStateStore;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyDouble;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.eq;
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
    private AircraftEnrichmentService enrichmentService;
    @Mock
    private AirportRepository airportRepository;

    private FlightController controller() {
        return new FlightController(liveStateStore, positionRepository, viewportService, enrichmentService, airportRepository);
    }

    // LiveAircraft has no public constructor test helper of its own (it's a
    // plain record) — this just fills every field with an innocuous default
    // except the ones a given test cares about.
    private static LiveAircraft live(String icao24, String callsign) {
        Instant now = Instant.now();
        return new LiveAircraft(1L, icao24, callsign, now, 59.0, 18.0,
                null, null, null, null, false, "opensky", null, null, null, null);
    }

    private static Route route(String origin, String originName, String destination, String destinationName) {
        return new Route(origin, originName, null, null, destination, destinationName, null, null);
    }

    @Test
    void airportNonBlank_matchesCityViaReferenceTableCodes_ignoringQEvenIfPresent() {
        // "Kalmar" is a municipality, not in the route itself: the airport
        // table resolves it to ESMQ, and the flight's route ends there.
        when(airportRepository.findIcaoCodesMatching("kalmar")).thenReturn(Set.of("ESMQ"));
        when(liveStateStore.liveAircraft(any(), any()))
                .thenReturn(List.of(live("abc123", "BRX101"), live("def456", "SAS100")));
        when(enrichmentService.knownRoute("abc123", "BRX101"))
                .thenReturn(Optional.of(route("ESSB", "Stockholm Bromma Airport", "ESMQ", "Kalmar Airport")));
        when(enrichmentService.knownRoute("def456", "SAS100"))
                .thenReturn(Optional.of(route("ESSA", "Stockholm Arlanda", "EGLL", "London Heathrow")));

        List<FlightPosition> result = controller().search("SAS123", "Kalmar");

        assertThat(result).extracting(FlightPosition::icao24).containsExactly("abc123");
        verify(liveStateStore, never()).searchByCallsign(any(), any(), any(), anyInt());
    }

    @Test
    void airportNonBlank_matchesRouteNameEvenWithoutAReferenceTableHit() {
        when(airportRepository.findIcaoCodesMatching("arlanda")).thenReturn(Set.of());
        when(liveStateStore.liveAircraft(any(), any())).thenReturn(List.of(live("abc123", "SAS100")));
        when(enrichmentService.knownRoute("abc123", "SAS100"))
                .thenReturn(Optional.of(route("ESSA", "Stockholm Arlanda", "EGLL", null)));

        List<FlightPosition> result = controller().search(null, "Arlanda");

        assertThat(result).extracting(FlightPosition::icao24).containsExactly("abc123");
    }

    @Test
    void airportNonBlank_aircraftWithNoKnownRoute_isNotMatched() {
        when(airportRepository.findIcaoCodesMatching("narita")).thenReturn(Set.of("RJAA"));
        when(liveStateStore.liveAircraft(any(), any())).thenReturn(List.of(live("abc123", "SAS100"), live("def456", "N123AB")));
        when(enrichmentService.knownRoute("abc123", "SAS100"))
                .thenReturn(Optional.of(route("ESSA", "Stockholm Arlanda", "EGLL", "London Heathrow")));
        when(enrichmentService.knownRoute("def456", "N123AB")).thenReturn(Optional.empty());

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

    @Test
    void liveOverview_clampsLimitAndPerCell_andUsesTheActiveTrafficWindow() {
        when(liveStateStore.overview(any(), any(), any(), any(), eq(2.0), anyInt(), anyInt()))
                .thenReturn(new LiveOverview(List.of(), List.of()));

        controller().liveOverview(-90, 90, -180, 180, 2.0, 99_999, 99);
        verify(liveStateStore).overview(any(), any(), any(), any(), eq(2.0), eq(1000), eq(20)); // capped

        controller().liveOverview(-90, 90, -180, 180, 2.0, -5, 0);
        verify(liveStateStore).overview(any(), any(), any(), any(), eq(2.0), eq(0), eq(1)); // floored
    }

    @Test
    void liveOverview_neverTouchesTheReportedViewport() {
        when(liveStateStore.overview(any(), any(), any(), any(), anyDouble(), anyInt(), anyInt()))
                .thenReturn(new LiveOverview(List.of(), List.of()));

        controller().liveOverview(-90, 90, -180, 180, 2.0, 200, 3);

        // A world-sized bbox must not become "the current viewport" (hot poll / broadcaster).
        verifyNoInteractions(viewportService);
    }
}
