package com.flighttracker.service.confirmation;

import com.flighttracker.dto.TrackStatus;
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
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.mock.env.MockEnvironment;
import org.springframework.test.web.client.MockRestServiceServer;
import org.springframework.web.client.RestClient;

import java.io.IOException;
import java.net.ConnectException;
import java.time.Duration;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static com.flighttracker.service.confirmation.AeroDataBoxArrivalProviderTest.BASE;
import static com.flighttracker.service.confirmation.AeroDataBoxArrivalProviderTest.CPA271;
import static com.flighttracker.service.confirmation.AeroDataBoxArrivalProviderTest.fixture;
import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.client.ExpectedCount.manyTimes;
import static org.springframework.test.web.client.ExpectedCount.once;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.method;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.requestTo;
import static org.springframework.test.web.client.response.MockRestResponseCreators.withException;
import static org.springframework.test.web.client.response.MockRestResponseCreators.withStatus;
import static org.springframework.test.web.client.response.MockRestResponseCreators.withSuccess;

/** The AeroDataBox provider through the real gateway and service, over the reconstructed CX271 fixtures. */
class AeroDataBoxConfirmationTest {

    private final TestClock clock = new TestClock();
    private final LiveStateStore live = mock(LiveStateStore.class);
    private final CallsignRouteService routes = mock(CallsignRouteService.class);
    private final TrainingDataService training = mock(TrainingDataService.class);
    private final AircraftRepository aircraftRepository = mock(AircraftRepository.class);
    private final RunwayIndex runways = new RunwayIndex();
    private final ConfirmationStore store = new ConfirmationStore(120, 100);
    private final Map<String, LiveAircraft> aircraft = new LinkedHashMap<>();
    private MockRestServiceServer server;
    private RestClient.Builder builder;
    private Instant now;

    @BeforeEach
    void setUp() {
        now = Instant.parse("2026-10-12T06:20:00Z");
        clock.set(now);
        when(live.liveAircraft(any(), any())).thenAnswer(i -> List.copyOf(aircraft.values()));
        when(live.get(anyString())).thenAnswer(i -> Optional.ofNullable(aircraft.get(i.<String>getArgument(0))));
        when(routes.cached(anyString())).thenReturn(Optional.empty());
        when(aircraftRepository.findById(anyString())).thenReturn(Optional.empty());
        runways.replace(List.of(new Runway("EHAM", "18R", 52.32, 4.78, 183, 0.0, 3800),
                new Runway("ESSA", "19R", 59.65, 17.93, 190, 40.0, 3300)));
        builder = RestClient.builder();
        server = MockRestServiceServer.bindTo(builder).build();
    }

    private AeroDataBoxArrivalProvider provider(boolean labels) {
        return new AeroDataBoxArrivalProvider(clock, new PhaseLogger(), true, "test-key", BASE, "aerodatabox.p.rapidapi.com",
                "Number", labels, builder);
    }

    private ConfirmationGateway gateway(ConfirmationBudgets budgets) {
        return new ConfirmationGateway(clock, 30, budgets, 1000, 300, 60, 300, 100);
    }

    private ArrivalConfirmationService service(ConfirmationGateway gateway, List<ArrivalConfirmationProvider> providers,
                                               List<AirportArrivalsProvider> boards) {
        return new ArrivalConfirmationService(providers, boards, aircraftRepository, gateway, store, live,
                routes, runways, training, clock, 0.5, 120, 300, 45, 15);
    }

    private ArrivalConfirmationService service(AeroDataBoxArrivalProvider provider) {
        return service(gateway(InMemoryAppState.budgets(clock, 300)), List.of(provider), List.of());
    }

    private LiveAircraft addInferred(String icao24, String callsign, String airport, Instant touchdownAt) {
        GapEstimate gap = new GapEstimate(TrackState.LANDED_INFERRED, 0.92, 0.08, 52.32, 4.78, 800, now, airport, "18R",
                touchdownAt, null, "physics-v1");
        LiveAircraft a = new LiveAircraft(1L, icao24, callsign, now.minusSeconds(1800), // last report before the gap, before the touchdown
                 52.3, 4.7, 300.0, 70.0, 183.0, -3.0, false,
                "opensky", null, gap.estLat(), gap.estLon(), gap.at(), gap);
        aircraft.put(icao24, a);
        return a;
    }

    // ---- end to end

    @Test
    void anInferredLandingAtEhamBecomesLandedConfirmedFromAeroDataBox() throws IOException {
        LiveAircraft a = addInferred("780a8c", "CPA271", "EHAM", Instant.parse("2026-10-12T06:00:00Z"));
        server.expect(once(), requestTo(CPA271))
                .andRespond(withSuccess(fixture("cx271-two-days.json"), MediaType.APPLICATION_JSON));

        service(provider(false)).tick();

        server.verify();
        TrackStatus status = TrackStatus.from(a, store.forAircraft(a));
        assertThat(status.state()).isEqualTo(TrackState.LANDED_CONFIRMED);
        assertThat(status.source()).isEqualTo("aerodatabox");
        assertThat(status.terminal()).isEqualTo("2");
        assertThat(status.confirmedAt()).isEqualTo(Instant.parse("2026-10-12T06:02:00Z"));
    }

    @Test
    void aRevisedGateTimeBecomesAtGate() throws IOException {
        LiveAircraft a = addInferred("780a8c", "CPA271", "EHAM", Instant.parse("2026-10-12T06:00:00Z"));
        server.expect(once(), requestTo(CPA271))
                .andRespond(withSuccess(fixture("arrived-at-gate.json"), MediaType.APPLICATION_JSON));

        service(provider(false)).tick();

        TrackStatus status = TrackStatus.from(a, store.forAircraft(a));
        assertThat(status.state()).isEqualTo(TrackState.AT_GATE);
        assertThat(status.gate()).isEqualTo("D87");
    }

    @Test
    void anApproachingAnswerConfirmsNothing() throws IOException {
        LiveAircraft a = addInferred("780a8c", "CPA271", "EHAM", Instant.parse("2026-10-12T06:00:00Z"));
        server.expect(once(), requestTo(CPA271))
                .andRespond(withSuccess(fixture("approaching.json"), MediaType.APPLICATION_JSON));

        service(provider(false)).tick();

        assertThat(store.forAircraft(a)).isEmpty();
    }

    // ---- training labels

    @Test
    void noTrainingLabelIsWrittenByDefault() throws IOException {
        LiveAircraft a = addInferred("780a8c", "CPA271", "EHAM", Instant.parse("2026-10-12T06:00:00Z"));
        server.expect(once(), requestTo(CPA271))
                .andRespond(withSuccess(fixture("cx271-two-days.json"), MediaType.APPLICATION_JSON));

        service(provider(false)).tick();

        assertThat(store.forAircraft(a)).isPresent();
        verify(training, never()).recordConfirmedLanding(any(), any(), any(), any(), any());
    }

    @Test
    void aTrainingLabelIsWrittenWhenTheFlagIsTrue() throws IOException {
        LiveAircraft a = addInferred("780a8c", "CPA271", "EHAM", Instant.parse("2026-10-12T06:00:00Z"));
        server.expect(once(), requestTo(CPA271))
                .andRespond(withSuccess(fixture("cx271-two-days.json"), MediaType.APPLICATION_JSON));

        service(provider(true)).tick();

        verify(training).recordConfirmedLanding("780a8c", a.observedAt(), "aerodatabox",
                Instant.parse("2026-10-12T06:02:00Z"), "EHAM");
    }

    // ---- budgets

    @Test
    void eachLookupChargesTwoUnitsAndTheDailyBudgetOf14StopsTheEighth() {
        MockEnvironment env = new MockEnvironment()
                .withProperty("flighttracker.confirmation.providers.aerodatabox.monthly-budget", "380")
                .withProperty("flighttracker.confirmation.providers.aerodatabox.daily-budget", "14");
        ConfirmationBudgets budgets = new ConfirmationBudgets(new InMemoryAppState(clock), clock, env, new PhaseLogger(), 300);
        ConfirmationGateway gateway = gateway(budgets);
        AeroDataBoxArrivalProvider provider = provider(false);

        server.expect(manyTimes(), method(HttpMethod.GET)).andRespond(withStatus(HttpStatus.NO_CONTENT));
        ConfirmationGateway.Outcome first = gateway.lookup(provider, AeroDataBoxArrivalProviderTest.query(now));
        assertThat(first.kind()).isEqualTo(ConfirmationGateway.Kind.CALLED);
        assertThat(gateway.unitsToday("aerodatabox")).isEqualTo(2);
        assertThat(gateway.unitsThisMonth("aerodatabox")).isEqualTo(2);

        for (int i = 2; i <= 7; i++) {
            clock.advance(Duration.ofSeconds(31)); // the gateway's 30 s spacing
            String callsign = "CPA" + (270 + i);
            ConfirmationGateway.Outcome o = gateway.lookup(provider, new ArrivalQuery("780a8c", callsign, "EHAM", now));
            assertThat(o.kind()).as("call %d", i).isEqualTo(ConfirmationGateway.Kind.CALLED);
        }
        assertThat(gateway.unitsToday("aerodatabox")).isEqualTo(14);

        clock.advance(Duration.ofSeconds(31));
        ConfirmationGateway.Outcome eighth = gateway.lookup(provider, new ArrivalQuery("780a8c", "CPA999", "EHAM", now));
        assertThat(eighth.kind()).isEqualTo(ConfirmationGateway.Kind.SKIPPED);
        assertThat(gateway.unitsToday("aerodatabox")).isEqualTo(14);
    }

    // ---- one aircraft must not spend the day (7 lookups)

    /** Ticks every 31 s (the gateway's spacing) until {@code until} after the start; returns the lookups made. */
    private int tickFor(ArrivalConfirmationService svc, ConfirmationGateway gateway, Duration until) {
        Instant end = clock.instant().plus(until);
        while (clock.instant().isBefore(end)) {
            svc.tick();
            clock.advance(Duration.ofSeconds(31));
        }
        return gateway.unitsToday("aerodatabox") / 2;
    }

    @Test
    void anArrivedFlightWithoutAGateCostsExactlyOneLookup() throws IOException {
        LiveAircraft a = addInferred("780a8c", "CPA271", "EHAM", Instant.parse("2026-10-12T06:00:00Z"));
        server.expect(manyTimes(), requestTo(CPA271))
                .andRespond(withSuccess(fixture("cx271-two-days.json"), MediaType.APPLICATION_JSON));
        ConfirmationGateway gateway = gateway(InMemoryAppState.budgets(clock, 300));
        ArrivalConfirmationService svc = service(gateway, List.of(provider(false)), List.of());

        int lookups = tickFor(svc, gateway, Duration.ofMinutes(60)); // past the global 45 min gate wait

        assertThat(store.forAircraft(a)).isPresent();
        assertThat(lookups).isEqualTo(1);
    }

    @Test
    void anApproachingFlightIsAskedAgainNoSoonerThanThirtyMinutes() throws IOException {
        addInferred("780a8c", "CPA271", "EHAM", Instant.parse("2026-10-12T06:00:00Z"));
        server.expect(manyTimes(), requestTo(CPA271))
                .andRespond(withSuccess(fixture("approaching.json"), MediaType.APPLICATION_JSON));
        ConfirmationGateway gateway = gateway(InMemoryAppState.budgets(clock, 300));
        ArrivalConfirmationService svc = service(gateway, List.of(provider(false)), List.of());

        assertThat(tickFor(svc, gateway, Duration.ofMinutes(29))).isEqualTo(1);
        assertThat(tickFor(svc, gateway, Duration.ofMinutes(2))).isEqualTo(2);
        assertThat(tickFor(svc, gateway, Duration.ofMinutes(28))).isEqualTo(2);
    }

    @Test
    void anUnknownFlightIsAskedAgainNoSoonerThanThreeHours() {
        addInferred("780a8c", "CPA271", "EHAM", Instant.parse("2026-10-12T06:00:00Z"));
        server.expect(manyTimes(), requestTo(CPA271)).andRespond(withStatus(HttpStatus.NO_CONTENT));
        ConfirmationGateway gateway = gateway(InMemoryAppState.budgets(clock, 300));
        ArrivalConfirmationService svc = service(gateway, List.of(provider(false)), List.of());

        assertThat(tickFor(svc, gateway, Duration.ofMinutes(179))).isEqualTo(1);
        assertThat(tickFor(svc, gateway, Duration.ofMinutes(2))).isEqualTo(2);
    }

    @Test
    void anUnusableCallsignCostsNothing_andTheNextCandidateIsStillAskedInTheSameTick() throws IOException {
        // The unusable one sorts first (earlier touchdown).
        addInferred("111111", "ABC/DEF-TOO-LONG", "EHAM", Instant.parse("2026-10-12T05:50:00Z"));
        addInferred("780a8c", "CPA271", "EHAM", Instant.parse("2026-10-12T06:00:00Z"));
        server.expect(once(), requestTo(CPA271))
                .andRespond(withSuccess(fixture("cx271-two-days.json"), MediaType.APPLICATION_JSON));
        ConfirmationGateway gateway = gateway(InMemoryAppState.budgets(clock, 300));

        service(gateway, List.of(provider(false)), List.of()).tick();

        server.verify();
        assertThat(gateway.unitsToday("aerodatabox")).isEqualTo(2); // only CPA271's lookup
        assertThat(store.forAircraft(aircraft.get("780a8c"))).isPresent();
    }

    @Test
    void aRefusedConnectionOrAThrottledCallIsRefunded_butA5xxIsNot() {
        ConfirmationBudgets budgets = InMemoryAppState.budgets(clock, 300);
        server.expect(once(), requestTo(CPA271)).andRespond(withException(new ConnectException("Connection refused")));
        server.expect(once(), requestTo(CPA271)).andRespond(withStatus(HttpStatus.TOO_MANY_REQUESTS));
        server.expect(once(), requestTo(CPA271)).andRespond(withStatus(HttpStatus.INTERNAL_SERVER_ERROR));
        AeroDataBoxArrivalProvider provider = provider(false);
        // A fresh gateway per call: the backoff after a failure is stamped with the system clock.
        ArrivalQuery query = AeroDataBoxArrivalProviderTest.query(now);

        gateway(budgets).lookup(provider, query);
        assertThat(budgets.unitsToday("aerodatabox")).as("never reached the API").isZero();

        gateway(budgets).lookup(provider, query);
        assertThat(budgets.unitsToday("aerodatabox")).as("429").isZero();

        gateway(budgets).lookup(provider, query);
        server.verify();
        assertThat(budgets.unitsToday("aerodatabox")).as("5xx").isEqualTo(2);
        assertThat(budgets.unitsThisMonth("aerodatabox")).isEqualTo(2);
    }

    // ---- precedence

    @Test
    void anEnabledSwedaviaKeepsAeroDataBoxOutOfSwedishAirportsButNotOutOfTheRest() throws IOException {
        RestClient.Builder swedaviaBuilder = RestClient.builder();
        MockRestServiceServer swedaviaServer = MockRestServiceServer.bindTo(swedaviaBuilder).build();
        SwedaviaArrivalsProvider swedavia = new SwedaviaArrivalsProvider(clock, new PhaseLogger(), true, "swe-key", "",
                SwedaviaArrivalsProviderTest.BASE, swedaviaBuilder);
        swedaviaServer.expect(once(), requestTo(SwedaviaArrivalsProviderTest.ARN_TODAY))
                .andRespond(withSuccess("{\"flights\":[]}", MediaType.APPLICATION_JSON));
        addInferred("4a1234", "SAS1402", "ESSA", Instant.parse("2026-10-12T06:00:00Z"));
        // AeroDataBox's server has no expectation for ESSA: a call to it fails the test.

        ArrivalConfirmationService svc = service(gateway(InMemoryAppState.budgets(clock, 300)),
                List.of(provider(false)), List.of(swedavia));
        svc.tick();
        swedaviaServer.verify();

        // EHAM is not a Swedavia airport: AeroDataBox is asked.
        aircraft.clear();
        addInferred("780a8c", "CPA271", "EHAM", Instant.parse("2026-10-12T06:00:00Z"));
        server.expect(once(), requestTo(CPA271))
                .andRespond(withSuccess(fixture("cx271-two-days.json"), MediaType.APPLICATION_JSON));
        clock.advance(Duration.ofSeconds(31));
        svc.tick();
        server.verify();
        assertThat(store.forAircraft(aircraft.get("780a8c")).orElseThrow().providerId()).isEqualTo("aerodatabox");
    }

    @Test
    void aSwedaviaWithoutAKeyIsNotInTheWay() throws IOException {
        SwedaviaArrivalsProvider swedavia = new SwedaviaArrivalsProvider(clock, new PhaseLogger(), true, "", "",
                SwedaviaArrivalsProviderTest.BASE, RestClient.builder());
        assertThat(swedavia.enabled()).isFalse();
        LiveAircraft a = addInferred("4a1234", "SAS1402", "ESSA", Instant.parse("2026-10-12T06:00:00Z"));
        server.expect(once(), requestTo(BASE + "/flights/Number/SAS1402?withAircraftImage=false&withLocation=false"))
                .andRespond(withSuccess(
                        "[{\"status\":\"Arrived\",\"codeshareStatus\":\"IsOperator\",\"arrival\":{\"airport\":{\"icao\":\"ESSA\"},"
                                + "\"runwayTime\":{\"utc\":\"2026-10-12 06:02Z\"},\"revisedTime\":{\"utc\":\"2026-10-12 06:02Z\"}}}]",
                        MediaType.APPLICATION_JSON));

        service(gateway(InMemoryAppState.budgets(clock, 300)), List.of(provider(false)), List.of(swedavia)).tick();

        server.verify();
        assertThat(store.forAircraft(a).orElseThrow().providerId()).isEqualTo("aerodatabox");
    }
}
