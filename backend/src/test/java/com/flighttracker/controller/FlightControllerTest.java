package com.flighttracker.controller;

import com.flighttracker.dto.LiveOverview;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.cfg.DateTimeFeature;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import com.flighttracker.dto.TrackStatus;
import com.flighttracker.model.FlightPosition;
import com.flighttracker.service.coverage.GapEstimate;
import com.flighttracker.service.coverage.TrackState;
import org.springframework.http.ResponseEntity;
import com.flighttracker.repository.AirportRepository;
import com.flighttracker.repository.FlightPositionRepository;
import com.flighttracker.service.ViewportService;
import com.flighttracker.service.enrichment.AircraftEnrichmentService;
import com.flighttracker.service.enrichment.Route;
import com.flighttracker.service.confirmation.ArrivalInfo;
import com.flighttracker.service.confirmation.Confirmation;
import com.flighttracker.service.confirmation.ConfirmationStore;
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
    private final ConfirmationStore confirmationStore = new ConfirmationStore(120, 100);

    private FlightController controller() {
        return new FlightController(liveStateStore, positionRepository, viewportService, enrichmentService, airportRepository, confirmationStore);
    }

    // LiveAircraft has no public constructor test helper of its own (it's a
    // plain record) — this just fills every field with an innocuous default
    // except the ones a given test cares about.
    private static LiveAircraft live(String icao24, String callsign) {
        Instant now = Instant.now();
        return new LiveAircraft(1L, icao24, callsign, now, 59.0, 18.0,
                null, null, null, null, false, "opensky", null, null, null, null, null);
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

        controller().liveOverview(-90, 90, -180, 180, 2.0, 99_999, 99, false);
        verify(liveStateStore).overview(any(), any(), any(), any(), eq(2.0), eq(2000), eq(20)); // capped

        controller().liveOverview(-90, 90, -180, 180, 2.0, -5, 0, false);
        verify(liveStateStore).overview(any(), any(), any(), any(), eq(2.0), eq(0), eq(1)); // floored
    }

    @Test
    void liveOverview_declutterAsksForTheClusterFreeVariant_clampedAndFlooredLikeTheOther() {
        when(liveStateStore.discovered(any(), any(), any(), any(), anyDouble(), anyInt()))
                .thenReturn(new LiveOverview(List.of(), List.of()));

        controller().liveOverview(-90, 90, -180, 180, 0.01, 99_999, 6, true);
        verify(liveStateStore).discovered(any(), any(), any(), any(), eq(0.5), eq(2000)); // cell floored, planes capped

        controller().liveOverview(-90, 90, -180, 180, 999, -5, 6, true);
        verify(liveStateStore).discovered(any(), any(), any(), any(), eq(40.0), eq(0));
        verify(liveStateStore, never()).overview(any(), any(), any(), any(), anyDouble(), anyInt(), anyInt());
    }

    @Test
    void liveOverview_neverTouchesTheReportedViewport() {
        when(liveStateStore.overview(any(), any(), any(), any(), anyDouble(), anyInt(), anyInt()))
                .thenReturn(new LiveOverview(List.of(), List.of()));

        controller().liveOverview(-90, 90, -180, 180, 2.0, 200, 3, false);

        // A world-sized bbox must not become "the current viewport" (hot poll / broadcaster).
        verifyNoInteractions(viewportService);
    }

    @Test
    void liveCount_activeAsksForTheActiveTrafficWindowOnly() {
        when(liveStateStore.countActive(any())).thenReturn(7L);
        when(liveStateStore.countLive(any(), any())).thenReturn(70L);

        assertThat(controller().liveCount(true)).isEqualTo(7L);
        assertThat(controller().liveCount(false)).isEqualTo(70L);
    }

    @Test
    void liveOne_mixedCaseIcao24_isLookedUpLowerCase() {
        when(liveStateStore.findLatestPosition("4aab14"))
                .thenReturn(Optional.of(new FlightPosition("4aab14", "SAS1", Instant.now(), 59.0, 18.0,
                        null, null, null, null, false, "opensky")));

        assertThat(controller().liveOne("4AAB14").getStatusCode().value()).isEqualTo(200);
        verify(liveStateStore).findLatestPosition("4aab14");
    }

    // ---- GET /{icao24}/status

    private JsonNode statusJson(LiveAircraft a) throws Exception {
        when(liveStateStore.get(a.icao24())).thenReturn(Optional.of(a));
        ResponseEntity<TrackStatus> response = controller().status(a.icao24());
        assertThat(response.getStatusCode().value()).isEqualTo(200);
        ObjectMapper mapper = JsonMapper.builder().disable(DateTimeFeature.WRITE_DATES_AS_TIMESTAMPS).build();
        return mapper.readTree(mapper.writeValueAsString(response.getBody()));
    }

    private static LiveAircraft withGap(boolean onGround, GapEstimate gap) {
        Instant seen = Instant.parse("2026-10-12T11:00:00Z");
        return new LiveAircraft(1L, "4ca123", "SAS123", seen, 59.60, 17.90, null, null, null, null,
                onGround, "opensky", null, gap == null ? null : gap.estLat(), gap == null ? null : gap.estLon(),
                gap == null ? null : gap.at(), gap);
    }

    private static GapEstimate gap(TrackState state) {
        Instant at = Instant.parse("2026-10-12T11:02:00Z");
        return new GapEstimate(state, 0.4, 0.85, 59.65, 17.93, 1800, at, "ESSA", "19R",
                Instant.parse("2026-10-12T11:03:10Z"), null, "physics-v1");
    }

    @Test
    void status_unknownAircraft_is404() {
        when(liveStateStore.get("000000")).thenReturn(Optional.empty());

        assertThat(controller().status("000000").getStatusCode().value()).isEqualTo(404);
    }

    @Test
    void status_live_hasTheContractKeys_andNullsWhereNotApplicable() throws Exception {
        JsonNode json = statusJson(withGap(false, null));

        assertThat(json.get("state").asText()).isEqualTo("LIVE");
        assertThat(json.get("confidence").isNull()).isTrue();
        assertThat(json.get("source").asText()).isEqualTo("adsb");
        assertThat(json.get("sourceKind").asText()).isEqualTo("observed");
        assertThat(json.get("lastSeenAt").asText()).isEqualTo("2026-10-12T11:00:00Z");
        for (String k : List.of("estimate", "landing", "gate", "terminal", "confirmedAt")) {
            assertThat(json.has(k)).as(k).isTrue();
            assertThat(json.get(k).isNull()).as(k).isTrue();
        }
    }

    @Test
    void status_onGround_isObservedWithFullConfidence() throws Exception {
        JsonNode json = statusJson(withGap(true, null));

        assertThat(json.get("state").asText()).isEqualTo("ON_GROUND");
        assertThat(json.get("confidence").asDouble()).isEqualTo(1.0);
        assertThat(json.get("sourceKind").asText()).isEqualTo("observed");
        assertThat(json.get("estimate").isNull()).isTrue();
        assertThat(json.get("landing").isNull()).isTrue();
    }

    @Test
    void status_coverageLost_isInferredWithEstimateAndLanding() throws Exception {
        JsonNode json = statusJson(withGap(false, gap(TrackState.COVERAGE_LOST)));

        assertThat(json.get("state").asText()).isEqualTo("COVERAGE_LOST");
        assertThat(json.get("confidence").asDouble()).isEqualTo(0.85);
        assertThat(json.get("source").asText()).isEqualTo("physics");
        assertThat(json.get("sourceKind").asText()).isEqualTo("inferred");
        assertThat(json.get("lastSeenLat").asDouble()).isEqualTo(59.60);
        assertThat(json.get("estimate").get("lat").asDouble()).isEqualTo(59.65);
        assertThat(json.get("estimate").get("radiusM").asDouble()).isEqualTo(1800);
        assertThat(json.get("estimate").get("landingProbability").asDouble()).isEqualTo(0.4);
        assertThat(json.get("landing").get("airportIcao").asText()).isEqualTo("ESSA");
        assertThat(json.get("landing").get("runway").asText()).isEqualTo("19R");
        assertThat(json.get("landing").get("touchdownAt").asText()).isEqualTo("2026-10-12T11:03:10Z");
    }

    @Test
    void status_landedInferred_isInferredAndKeepsTheLanding() throws Exception {
        JsonNode json = statusJson(withGap(false, gap(TrackState.LANDED_INFERRED)));

        assertThat(json.get("state").asText()).isEqualTo("LANDED_INFERRED");
        assertThat(json.get("sourceKind").asText()).isEqualTo("inferred");
        assertThat(json.get("estimate").isNull()).isFalse();
        assertThat(json.get("landing").get("touchdownAt").asText()).isEqualTo("2026-10-12T11:03:10Z");
    }

    @Test
    void status_providerConfirmation_isServedAsAtGate_withTheContractShape() throws Exception {
        LiveAircraft a = withGap(false, gap(TrackState.LANDED_INFERRED));
        Instant on = Instant.parse("2026-10-12T11:03:30Z");
        Instant in = Instant.parse("2026-10-12T11:11:30Z");
        confirmationStore.put(a.icao24(), new Confirmation("mock",
                new ArrivalInfo(null, null, on, in, "B14", "2", "ESSA"), in, a.observedAt()));

        JsonNode json = statusJson(a);

        assertThat(json.get("state").asText()).isEqualTo("AT_GATE");
        assertThat(json.get("confidence").asDouble()).isEqualTo(1.0);
        assertThat(json.get("source").asText()).isEqualTo("mock");
        assertThat(json.get("sourceKind").asText()).isEqualTo("confirmed");
        assertThat(json.get("estimate").isNull()).isTrue();
        assertThat(json.get("gate").asText()).isEqualTo("B14");
        assertThat(json.get("terminal").asText()).isEqualTo("2");
        assertThat(json.get("confirmedAt").asText()).isEqualTo("2026-10-12T11:11:30Z");
        assertThat(json.get("landing").get("airportIcao").asText()).isEqualTo("ESSA");
        assertThat(json.get("landing").get("runway").asText()).isEqualTo("19R");
        assertThat(json.get("landing").get("touchdownAt").asText()).isEqualTo("2026-10-12T11:03:30Z");
    }
}
