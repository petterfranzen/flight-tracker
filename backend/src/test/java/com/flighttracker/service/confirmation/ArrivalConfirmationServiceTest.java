package com.flighttracker.service.confirmation;

import com.flighttracker.service.coverage.GapEstimate;
import com.flighttracker.service.coverage.Runway;
import com.flighttracker.service.coverage.RunwayIndex;
import com.flighttracker.service.coverage.TrackState;
import com.flighttracker.service.enrichment.CallsignRouteService;
import com.flighttracker.service.enrichment.Route;
import com.flighttracker.service.live.LiveAircraft;
import com.flighttracker.service.live.LiveStateStore;
import com.flighttracker.service.training.TrainingDataService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.function.Function;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/** Candidate selection, the call budget per tick, covers(), the monotonic rule and the training label. */
class ArrivalConfirmationServiceTest {

    private static final class FakeProvider implements ArrivalConfirmationProvider {
        final String id;
        final List<ArrivalQuery> calls = new ArrayList<>();
        boolean enabled = true;
        List<String> airports = null; // null = covers everything
        Function<ArrivalQuery, LookupResult> answer = q -> LookupResult.notFound();

        FakeProvider(String id) {
            this.id = id;
        }

        @Override public String id() { return id; }
        @Override public boolean enabled() { return enabled; }
        @Override public boolean covers(String airport) { return airports == null || (airport != null && airports.contains(airport)); }
        @Override public LookupResult lookup(ArrivalQuery query) {
            calls.add(query);
            return answer.apply(query);
        }
    }

    private final TestClock clock = new TestClock();
    private final LiveStateStore live = mock(LiveStateStore.class);
    private final CallsignRouteService routes = mock(CallsignRouteService.class);
    private final TrainingDataService training = mock(TrainingDataService.class);
    private final RunwayIndex runways = new RunwayIndex();
    private final ConfirmationStore store = new ConfirmationStore(120, 100);
    private final Map<String, LiveAircraft> aircraft = new LinkedHashMap<>();
    private final FakeProvider provider = new FakeProvider("fake");
    private Instant now;

    @BeforeEach
    void setUp() {
        now = Instant.parse("2026-10-12T12:00:00Z");
        clock.set(now);
        when(live.liveAircraft(any(), any())).thenAnswer(i -> List.copyOf(aircraft.values()));
        when(live.get(anyString())).thenAnswer(i -> Optional.ofNullable(aircraft.get(i.<String>getArgument(0))));
        when(routes.cached(anyString())).thenReturn(Optional.empty());
        runways.replace(List.of(new Runway("ESSA", "19R", 59.65, 17.93, 190, 40.0, 3300)));
    }

    private ArrivalConfirmationService service(ArrivalConfirmationProvider... providers) {
        return service(0, providers);
    }

    /** minIntervalSeconds 0 so that only the service's own one-call-per-tick rule limits the calls. */
    private ArrivalConfirmationService service(long minIntervalSeconds, ArrivalConfirmationProvider... providers) {
        ConfirmationGateway gateway = new ConfirmationGateway(clock, minIntervalSeconds, 300, 1000);
        return new ArrivalConfirmationService(List.of(providers), gateway, store, live, routes, runways, training, clock,
                0.5, 120);
    }

    private GapEstimate gap(TrackState state, double probability, String airport, Instant touchdownAt) {
        return new GapEstimate(state, probability, state == TrackState.LANDED_INFERRED ? probability : 1 - probability,
                59.65, 17.93, 800, now, airport, airport == null ? null : "19R", touchdownAt, null, "physics-v1");
    }

    private LiveAircraft addGap(String icao24, String callsign, GapEstimate gap, Instant observedAt) {
        LiveAircraft a = new LiveAircraft(1L, icao24, callsign, observedAt, 59.6, 17.9, 300.0, 70.0, 190.0, -3.0, false,
                "opensky", null, gap.estLat(), gap.estLon(), gap.at(), gap);
        aircraft.put(icao24, a);
        return a;
    }

    private LiveAircraft addGround(String icao24, String callsign, Instant landedSince, double lat, double lon) {
        LiveAircraft a = new LiveAircraft(1L, icao24, callsign, landedSince.plusSeconds(60), lat, lon, 0.0, 5.0, 190.0, 0.0,
                true, "opensky", landedSince, null, null, null, null);
        aircraft.put(icao24, a);
        return a;
    }

    private LiveAircraft addAirborne(String icao24, String callsign, Instant observedAt) {
        LiveAircraft a = new LiveAircraft(1L, icao24, callsign, observedAt, 50.0, 10.0, 11000.0, 230.0, 90.0, 0.0, false,
                "opensky", null, null, null, null, null);
        aircraft.put(icao24, a);
        return a;
    }

    private static LookupResult found(Instant on, Instant in) {
        return LookupResult.found(new ArrivalInfo(null, null, on, in, in == null ? null : "B14", "2", "ESSA"));
    }

    // ---- candidate selection

    @Test
    void landedInferredGaps_areAskedAbout_withTheGapsAirportAndTouchdown() {
        Instant td = now.minusSeconds(300);
        addGap("a1", "SAS1", gap(TrackState.LANDED_INFERRED, 0.92, "ESSA", td), now.minusSeconds(900));

        service(provider).tick();

        assertThat(provider.calls).containsExactly(new ArrivalQuery("a1", "SAS1", "ESSA", td));
    }

    @Test
    void coverageLost_isAskedAboutOnlyAfterTheTouchdownPassed_withEnoughProbability() {
        addGap("early", "SAS1", gap(TrackState.COVERAGE_LOST, 0.9, "ESSA", now.plusSeconds(120)), now.minusSeconds(60));
        addGap("unlikely", "SAS2", gap(TrackState.COVERAGE_LOST, 0.3, "ESSA", now.minusSeconds(60)), now.minusSeconds(600));
        service(provider).tick();
        assertThat(provider.calls).isEmpty();

        addGap("due", "SAS3", gap(TrackState.COVERAGE_LOST, 0.5, "ESSA", now.minusSeconds(60)), now.minusSeconds(600));
        service(provider).tick();
        assertThat(provider.calls).extracting(ArrivalQuery::icao24).containsExactly("due");
    }

    @Test
    void onGroundAircraft_areAskedAboutWithinTwoHoursOfLanding_atTheNearestRunwaysAirport() {
        addGround("fresh", "SAS1", now.minus(Duration.ofMinutes(30)), 59.651, 17.931);
        addGround("old", "SAS2", now.minus(Duration.ofMinutes(130)), 59.651, 17.931);

        service(provider).tick();

        assertThat(provider.calls).extracting(ArrivalQuery::icao24).containsExactly("fresh");
        assertThat(provider.calls.get(0).arrivalAirportIcao()).isEqualTo("ESSA");
        assertThat(provider.calls.get(0).expectedArrivalAt()).isEqualTo(now.minus(Duration.ofMinutes(30)));
    }

    @Test
    void theArrivalAirportFallsBackToTheCallsignsDestination() {
        when(routes.cached("SAS1")).thenReturn(Optional.of(
                new Route("ESSA", null, null, null, "ESGG", null, null, null)));
        addGap("a1", "SAS1", gap(TrackState.LANDED_INFERRED, 0.92, null, now.minusSeconds(300)), now.minusSeconds(900));
        addGround("g1", "SAS1", now.minus(Duration.ofMinutes(10)), 10.0, 10.0); // far from any runway

        service(provider).tick();

        assertThat(provider.calls).extracting(ArrivalQuery::arrivalAirportIcao).containsOnly("ESGG");
    }

    @Test
    void airborneAircraft_andAircraftWithoutACallsign_areNotCandidates() {
        addAirborne("a1", "SAS1", now.minusSeconds(10));
        addGap("a2", null, gap(TrackState.LANDED_INFERRED, 0.9, "ESSA", now.minusSeconds(60)), now.minusSeconds(600));

        service(provider).tick();

        assertThat(provider.calls).isEmpty();
    }

    @Test
    void gapsComeBeforeOnGround_thenOldestFirst() {
        addGround("ground", "SAS9", now.minus(Duration.ofMinutes(100)), 59.651, 17.931);
        addGap("newer", "SAS2", gap(TrackState.LANDED_INFERRED, 0.9, "ESSA", now.minusSeconds(100)), now.minusSeconds(600));
        addGap("older", "SAS1", gap(TrackState.LANDED_INFERRED, 0.9, "ESSA", now.minusSeconds(500)), now.minusSeconds(900));

        ArrivalConfirmationService svc = service(provider);
        svc.tick();
        svc.tick();
        svc.tick();

        assertThat(provider.calls).extracting(ArrivalQuery::icao24).containsExactly("older", "newer", "ground");
    }

    // ---- calls per tick, covers(), enabled

    @Test
    void atMostOneRealCallPerProviderPerTick_andCachedAnswersAreFree() {
        FakeProvider other = new FakeProvider("other");
        for (int i = 0; i < 4; i++) {
            addGap("a" + i, "SAS" + i, gap(TrackState.LANDED_INFERRED, 0.9, "ESSA", now.minusSeconds(500 - i)), now.minusSeconds(900));
        }
        ArrivalConfirmationService svc = service(provider, other);

        svc.tick();
        assertThat(provider.calls).hasSize(1);
        assertThat(other.calls).hasSize(1);

        svc.tick();
        svc.tick();
        svc.tick();
        // each aircraft once (NOT_FOUND is cached 15 min), then nothing new to ask
        svc.tick();
        assertThat(provider.calls).extracting(ArrivalQuery::icao24).containsExactly("a0", "a1", "a2", "a3");
        assertThat(other.calls).hasSize(4);
    }

    @Test
    void onlyProvidersThatCoverTheAirportAreAsked() {
        FakeProvider swedish = new FakeProvider("swe");
        swedish.airports = List.of("ESSA");
        FakeProvider norwegian = new FakeProvider("nor");
        norwegian.airports = List.of("ENGM");
        addGap("a1", "SAS1", gap(TrackState.LANDED_INFERRED, 0.9, "ESSA", now.minusSeconds(60)), now.minusSeconds(600));

        service(swedish, norwegian).tick();

        assertThat(swedish.calls).hasSize(1);
        assertThat(norwegian.calls).isEmpty();
    }

    @Test
    void aProviderThatDoesNotCoverTheFirstAirport_stillGetsTheNextCandidate() {
        provider.airports = List.of("ESGG");
        addGap("a1", "SAS1", gap(TrackState.LANDED_INFERRED, 0.9, "ESSA", now.minusSeconds(500)), now.minusSeconds(900));
        addGap("a2", "SAS2", gap(TrackState.LANDED_INFERRED, 0.9, "ESGG", now.minusSeconds(100)), now.minusSeconds(900));

        service(provider).tick();

        assertThat(provider.calls).extracting(ArrivalQuery::icao24).containsExactly("a2");
    }

    @Test
    void aDisabledProviderIsNeverAsked() {
        provider.enabled = false;
        addGap("a1", "SAS1", gap(TrackState.LANDED_INFERRED, 0.9, "ESSA", now.minusSeconds(60)), now.minusSeconds(600));

        service(provider).tick();

        assertThat(provider.calls).isEmpty();
        verify(live, never()).liveAircraft(any(), any());
    }

    @Test
    void theGatewayPacing_limitsTicksThatComeTooSoon() {
        addGap("a1", "SAS1", gap(TrackState.LANDED_INFERRED, 0.9, "ESSA", now.minusSeconds(500)), now.minusSeconds(900));
        addGap("a2", "SAS2", gap(TrackState.LANDED_INFERRED, 0.9, "ESSA", now.minusSeconds(100)), now.minusSeconds(900));
        ArrivalConfirmationService svc = service(30, provider);

        svc.tick();
        clock.advance(Duration.ofSeconds(10));
        svc.tick();
        assertThat(provider.calls).hasSize(1);

        clock.advance(Duration.ofSeconds(21));
        svc.tick();
        assertThat(provider.calls).hasSize(2);
    }

    // ---- the confirmation and the monotonic rule

    @Test
    void foundLanding_isStored_andTheTrainingLabelGetsTheProviderOutcome() {
        Instant td = now.minusSeconds(300);
        Instant on = now.minusSeconds(280);
        Instant gapKey = now.minusSeconds(900);
        LiveAircraft a = addGap("a1", "SAS1", gap(TrackState.LANDED_INFERRED, 0.92, "ESSA", td), gapKey);
        provider.answer = q -> found(on, null);

        service(provider).tick();

        Confirmation c = store.forAircraft(a).orElseThrow();
        assertThat(c.providerId()).isEqualTo("fake");
        assertThat(c.info().actualOn()).isEqualTo(on);
        verify(training).recordConfirmedLanding("a1", gapKey, "fake", on, "ESSA");
    }

    @Test
    void anOnGroundAircraftHasNoFeatureRowToLabel_soTheTrainingServiceIsNotCalled() {
        LiveAircraft a = addGround("g1", "SAS1", now.minus(Duration.ofMinutes(10)), 59.651, 17.931);
        provider.answer = q -> found(q.expectedArrivalAt(), q.expectedArrivalAt().plusSeconds(480));

        service(provider).tick();

        assertThat(store.forAircraft(a)).isPresent();
        verify(training, never()).recordConfirmedLanding(any(), any(), any(), any(), any());
    }

    @Test
    void theTrainingLabelIsWrittenOnce_notOnEveryCachedRepeat() {
        addGap("a1", "SAS1", gap(TrackState.LANDED_INFERRED, 0.92, "ESSA", now.minusSeconds(300)), now.minusSeconds(900));
        provider.answer = q -> found(now.minusSeconds(280), null);
        ArrivalConfirmationService svc = service(provider);

        svc.tick();
        svc.tick();
        svc.tick();

        verify(training, org.mockito.Mockito.times(1)).recordConfirmedLanding(any(), any(), any(), any(), any());
    }

    @Test
    void aConfirmationWithGateIn_isNotAskedAboutAgain_butOneWithoutIs() {
        Instant on = now.minus(Duration.ofMinutes(20));
        addGround("g1", "SAS1", on, 59.651, 17.931);
        provider.answer = q -> found(on, null);
        ArrivalConfirmationService svc = service(provider);
        svc.tick();

        // the cache TTL (5 min) passes: it is asked again, and now has the gate
        clock.advance(Duration.ofMinutes(6));
        provider.answer = q -> found(on, on.plusSeconds(480));
        svc.tick();
        assertThat(provider.calls).hasSize(2);
        assertThat(store.forAircraft(aircraft.get("g1")).orElseThrow().gateAt()).isEqualTo(on.plusSeconds(480));

        clock.advance(Duration.ofMinutes(6));
        svc.tick();
        assertThat(provider.calls).hasSize(2);
    }

    @Test
    void theConfirmationSurvivesTaxiing_andIsNeverDowngradedByALaterNotFound() {
        Instant on = now.minus(Duration.ofMinutes(20));
        addGround("g1", "SAS1", on, 59.651, 17.931);
        provider.answer = q -> found(on, null);
        ArrivalConfirmationService svc = service(provider);
        svc.tick();

        // more ground reports (taxiing), then the provider forgets the flight
        addGround("g1", "SAS1", on, 59.652, 17.932);
        provider.answer = q -> LookupResult.notFound();
        clock.advance(Duration.ofMinutes(16));
        svc.tick();

        assertThat(provider.calls).hasSize(2);
        Confirmation c = store.forAircraft(aircraft.get("g1")).orElseThrow();
        assertThat(c.info().actualOn()).isEqualTo(on);
    }

    @Test
    void aNewFlight_clearsTheConfirmation() {
        Instant on = now.minus(Duration.ofMinutes(20));
        addGround("g1", "SAS1", on, 59.651, 17.931);
        provider.answer = q -> found(on, on.plusSeconds(480));
        ArrivalConfirmationService svc = service(provider);
        svc.tick();
        assertThat(store.size()).isEqualTo(1);

        addAirborne("g1", "SAS2", on.plus(Duration.ofMinutes(40)));
        svc.tick();

        assertThat(store.size()).isZero();
        assertThat(store.forAircraft(aircraft.get("g1"))).isEmpty();
    }

    @Test
    void confirmationsOfAircraftThatLeftTheLiveSetAreEvicted() {
        Instant on = now.minus(Duration.ofMinutes(20));
        addGround("g1", "SAS1", on, 59.651, 17.931);
        provider.answer = q -> found(on, null);
        ArrivalConfirmationService svc = service(provider);
        svc.tick();

        aircraft.remove("g1");
        svc.tick();

        assertThat(store.size()).isZero();
    }

    @Test
    void notFoundAndFailedAnswers_confirmNothing() {
        addGap("a1", "SAS1", gap(TrackState.LANDED_INFERRED, 0.9, "ESSA", now.minusSeconds(60)), now.minusSeconds(600));
        provider.answer = q -> LookupResult.failed();

        service(provider).tick();

        assertThat(store.size()).isZero();
        verify(training, never()).recordConfirmedLanding(any(), any(), any(), any(), any());
    }
}
