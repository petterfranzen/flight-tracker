package com.flighttracker.service.confirmation;

import com.flighttracker.observability.PhaseLogger;
import com.flighttracker.repository.AircraftRepository;
import com.flighttracker.service.coverage.GapEstimate;
import com.flighttracker.service.coverage.Runway;
import com.flighttracker.service.coverage.RunwayIndex;
import com.flighttracker.service.coverage.TrackState;
import com.flighttracker.service.enrichment.CallsignRouteService;
import com.flighttracker.service.live.LiveAircraft;
import com.flighttracker.service.live.LiveStateStore;
import com.flighttracker.service.training.TrainingDataService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;
import org.springframework.test.web.client.MockRestServiceServer;
import org.springframework.web.client.RestClient;

import java.io.IOException;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.client.ExpectedCount.once;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.header;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.requestTo;
import static org.springframework.test.web.client.response.MockRestResponseCreators.withSuccess;

/** The Swedavia provider through the real gateway and service, over the reconstructed ARN fixture. */
class SwedaviaConfirmationTest {

    private final TestClock clock = new TestClock();
    private final LiveStateStore live = mock(LiveStateStore.class);
    private final CallsignRouteService routes = mock(CallsignRouteService.class);
    private final TrainingDataService training = mock(TrainingDataService.class);
    private final AircraftRepository aircraftRepository = mock(AircraftRepository.class);
    private final RunwayIndex runways = new RunwayIndex();
    private final ConfirmationStore store = new ConfirmationStore(120, 100);
    private final Map<String, LiveAircraft> aircraft = new LinkedHashMap<>();
    private MockRestServiceServer server;
    private SwedaviaArrivalsProvider provider;
    private ConfirmationGateway gateway;
    private ArrivalConfirmationService service;
    private Instant now;

    @BeforeEach
    void setUp() {
        now = Instant.parse("2026-10-12T10:20:00Z");
        clock.set(now);
        when(live.liveAircraft(any(), any())).thenAnswer(i -> List.copyOf(aircraft.values()));
        when(live.get(anyString())).thenAnswer(i -> Optional.ofNullable(aircraft.get(i.<String>getArgument(0))));
        when(routes.cached(anyString())).thenReturn(Optional.empty());
        when(aircraftRepository.findById(anyString())).thenReturn(Optional.empty());
        runways.replace(List.of(new Runway("ESSA", "19R", 59.65, 17.93, 190, 40.0, 3300)));

        RestClient.Builder builder = RestClient.builder();
        server = MockRestServiceServer.bindTo(builder).build();
        provider = new SwedaviaArrivalsProvider(clock, new PhaseLogger(), true, "test-key", "",
                SwedaviaArrivalsProviderTest.BASE, builder);
        gateway = new ConfirmationGateway(clock, 30, InMemoryAppState.budgets(clock, 300), 1000, 300, 60, 300, 100);
        service = new ArrivalConfirmationService(List.of(), List.of(provider), aircraftRepository, gateway, store, live,
                routes, runways, training, clock, 0.5, 120, 300, 45, 15);
    }

    private LiveAircraft addInferred(String icao24, String callsign, String airport, Instant touchdownAt) {
        GapEstimate gap = new GapEstimate(TrackState.LANDED_INFERRED, 0.92, 0.08, 59.65, 17.93, 800, now, airport, "19R",
                touchdownAt, null, "physics-v1");
        LiveAircraft a = new LiveAircraft(1L, icao24, callsign, now.minusSeconds(900), 59.6, 17.9, 300.0, 70.0, 190.0, -3.0, false,
                "opensky", null, gap.estLat(), gap.estLon(), gap.at(), gap);
        aircraft.put(icao24, a);
        return a;
    }

    @Test
    void anInferredLandingBecomesAtGateE5FromTheBoard() throws IOException {
        LiveAircraft a = addInferred("4a1234", "SAS1402", "ESSA", Instant.parse("2026-10-12T10:03:00Z"));
        server.expect(once(), requestTo(SwedaviaArrivalsProviderTest.ARN_TODAY))
                .andExpect(header("Ocp-Apim-Subscription-Key", "test-key"))
                .andRespond(withSuccess(SwedaviaArrivalsProviderTest.fixture("arn-arrivals-2026-10-12.json"), MediaType.APPLICATION_JSON));

        service.tick();

        server.verify();
        Confirmation confirmation = store.forAircraft(a).orElseThrow();
        assertThat(confirmation.providerId()).isEqualTo("swedavia");
        assertThat(confirmation.landedAt()).isEqualTo(Instant.parse("2026-10-12T10:04:12Z"));
        assertThat(confirmation.gateAt()).isEqualTo(Instant.parse("2026-10-12T10:14:00Z"));
        assertThat(confirmation.info().gate()).isEqualTo("E5");
        assertThat(confirmation.info().terminal()).isEqualTo("5");
        assertThat(gateway.unitsToday("swedavia")).isEqualTo(1);
    }

    @Test
    void aCancelledOrScheduledEntryConfirmsNothing() throws IOException {
        addInferred("4a0001", "SAS2012", "ESSA", Instant.parse("2026-10-12T10:03:00Z"));
        addInferred("4a0002", "NOZ4001", "ESSA", Instant.parse("2026-10-12T10:04:00Z"));
        server.expect(once(), requestTo(SwedaviaArrivalsProviderTest.ARN_TODAY))
                .andRespond(withSuccess(SwedaviaArrivalsProviderTest.fixture("arn-arrivals-2026-10-12.json"), MediaType.APPLICATION_JSON));

        service.tick();

        assertThat(store.size()).isZero();
    }

    @Test
    void aTouchdownAt2230UtcInSummerFetchesTheNextLocalDatesBoard() {
        now = Instant.parse("2026-07-12T22:40:00Z");
        clock.set(now);
        addInferred("4a1234", "SAS1402", "ESSA", Instant.parse("2026-07-12T22:30:00Z"));
        server.expect(once(), requestTo(SwedaviaArrivalsProviderTest.BASE + "/ARN/arrivals/2026-07-13"))
                .andRespond(withSuccess("{\"flights\":[]}", MediaType.APPLICATION_JSON));

        service.tick();

        server.verify();
        // The board is cached under its local date: a second tick makes no second call.
        assertThat(gateway.boardCacheSize()).isEqualTo(1);
        service.tick();
        server.verify();
    }
}
