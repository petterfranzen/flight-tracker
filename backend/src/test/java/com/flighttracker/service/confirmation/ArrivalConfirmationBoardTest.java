package com.flighttracker.service.confirmation;

import com.flighttracker.model.Aircraft;
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

import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/** Board providers in the service: one fetch serves many candidates, matching, caching and the shared rules. */
class ArrivalConfirmationBoardTest {

    private static final class FakeBoards implements AirportArrivalsProvider {
        final String id;
        final List<String> fetches = new ArrayList<>();
        boolean enabled = true;
        List<String> airports = null; // null = covers everything
        final Map<String, List<BoardEntry>> boards = new LinkedHashMap<>(); // by airport
        BoardResult override;

        FakeBoards(String id) {
            this.id = id;
        }

        @Override public String id() { return id; }
        @Override public boolean enabled() { return enabled; }
        @Override public boolean covers(String airport) { return airports == null || (airport != null && airports.contains(airport)); }
        @Override public BoardResult fetchArrivals(String airport, LocalDate dateUtc) {
            fetches.add(airport + "@" + dateUtc);
            return override != null ? override : BoardResult.found(boards.getOrDefault(airport, List.of()));
        }
    }

    private final TestClock clock = new TestClock();
    private final LiveStateStore live = mock(LiveStateStore.class);
    private final CallsignRouteService routes = mock(CallsignRouteService.class);
    private final TrainingDataService training = mock(TrainingDataService.class);
    private final AircraftRepository aircraftRepository = mock(AircraftRepository.class);
    private final RunwayIndex runways = new RunwayIndex();
    private final ConfirmationStore store = new ConfirmationStore(120, 100);
    private final Map<String, LiveAircraft> aircraft = new LinkedHashMap<>();
    private final FakeBoards boards = new FakeBoards("sw");
    private Instant now;

    @BeforeEach
    void setUp() {
        now = Instant.parse("2026-10-12T12:00:00Z");
        clock.set(now);
        when(live.liveAircraft(any(), any())).thenAnswer(i -> List.copyOf(aircraft.values()));
        when(live.get(anyString())).thenAnswer(i -> Optional.ofNullable(aircraft.get(i.<String>getArgument(0))));
        when(routes.cached(anyString())).thenReturn(Optional.empty());
        when(aircraftRepository.findById(anyString())).thenReturn(Optional.empty());
        runways.replace(List.of(new Runway("ESSA", "19R", 59.65, 17.93, 190, 40.0, 3300)));
    }

    private ArrivalConfirmationService service(AirportArrivalsProvider... boardProviders) {
        ConfirmationGateway gateway = new ConfirmationGateway(clock, 0, InMemoryAppState.budgets(clock, 300), 1000, 300, 60, 300, 100);
        return new ArrivalConfirmationService(List.of(), List.of(boardProviders), aircraftRepository, gateway, store, live,
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

    private LiveAircraft addGround(String icao24, String callsign, Instant landedSince) {
        LiveAircraft a = new LiveAircraft(1L, icao24, callsign, landedSince.plusSeconds(60), 59.651, 17.931, 0.0, 5.0, 190.0, 0.0,
                true, "opensky", landedSince, null, null, null, null);
        aircraft.put(icao24, a);
        return a;
    }

    private static BoardEntry entry(String callsign, String registration, Instant on, Instant in, String gate) {
        return new BoardEntry(callsign, null, registration, new ArrivalInfo(null, null, on, in, gate, "5", "ESSA"));
    }

    private static Aircraft withRegistration(String icao24, String registration) {
        return new Aircraft(icao24, registration, null, null, null, null, null, null, null, null, null, null,
                null, null, null, Instant.EPOCH, Instant.EPOCH);
    }

    // ---- one fetch serves everyone

    @Test
    void oneFetch_servesEveryCandidateAtTheAirport() {
        Instant td = now.minus(Duration.ofMinutes(10));
        addInferred("a1", "SAS1", "ESSA", td);
        addInferred("a2", "NOZ2", "ESSA", td.plusSeconds(60));
        addGround("g3", "SAS3", td.plusSeconds(120));
        boards.boards.put("ESSA", List.of(
                entry("SAS1", null, td, null, null),
                entry("NOZ2", null, td.plusSeconds(60), td.plus(Duration.ofMinutes(8)), "B14"),
                entry("SAS3", null, td.plusSeconds(120), null, null),
                entry("DLH9", null, td, null, null)));

        service(boards).tick();

        assertThat(boards.fetches).hasSize(1);
        assertThat(store.size()).isEqualTo(3);
        assertThat(store.forAircraft(aircraft.get("a2")).orElseThrow().info().gate()).isEqualTo("B14");
        assertThat(store.forAircraft(aircraft.get("a1")).orElseThrow().providerId()).isEqualTo("sw");
    }

    @Test
    void theBoardIsFetchedForTheTouchdownsUtcDate() {
        addInferred("a1", "SAS1", "ESSA", Instant.parse("2026-10-11T23:50:00Z"));
        now = Instant.parse("2026-10-12T00:05:00Z");
        clock.set(now);

        service(boards).tick();

        assertThat(boards.fetches).containsExactly("ESSA@2026-10-11");
    }

    // ---- cache

    @Test
    void aFreshBoard_isReused_andAStaleOneFetchedAgainAndNowHasTheAircraft() {
        Instant td = now.minus(Duration.ofMinutes(10));
        addInferred("a1", "SAS1", "ESSA", td);
        ArrivalConfirmationService svc = service(boards);

        svc.tick(); // the board does not have SAS1 yet
        assertThat(store.size()).isZero();
        assertThat(boards.fetches).hasSize(1);

        boards.boards.put("ESSA", List.of(entry("SAS1", null, td, null, null)));
        clock.advance(Duration.ofSeconds(299));
        svc.tick(); // still the cached board: no call, no answer
        assertThat(boards.fetches).hasSize(1);
        assertThat(store.size()).isZero();

        clock.advance(Duration.ofMinutes(15)); // the board is stale and the recheck memo has run out
        svc.tick();
        assertThat(boards.fetches).hasSize(2);
        assertThat(store.size()).isEqualTo(1);
    }

    // ---- recheck memo

    @Test
    void aCandidateThatIsNotOnTheBoard_doesNotRefetchItEveryTtl_butOnlyEveryRecheckInterval() {
        addInferred("a1", "GA123", "ESSA", now.minus(Duration.ofMinutes(10)));
        boards.boards.put("ESSA", List.of(entry("SAS9", null, now, null, null)));
        ArrivalConfirmationService svc = service(boards);

        svc.tick();
        assertThat(boards.fetches).hasSize(1);

        for (int i = 0; i < 2; i++) { // the board is stale after 5 min: two stale ticks, still no new fetch
            clock.advance(Duration.ofSeconds(301));
            svc.tick();
        }
        assertThat(boards.fetches).hasSize(1);
        assertThat(store.size()).isZero();
    }

    @Test
    void theRecheckMemoCountsFromTheBoardsFetchTime() {
        addInferred("a1", "GA123", "ESSA", now.minus(Duration.ofMinutes(10)));
        boards.boards.put("ESSA", List.of(entry("SAS9", null, now, null, null)));
        ArrivalConfirmationService svc = service(boards);

        svc.tick(); // fetched at 12:00:00, no GA123 on it
        clock.advance(Duration.ofSeconds(301)); // 12:05:01, board stale
        svc.tick();
        clock.advance(Duration.ofMinutes(9)); // 12:14:01
        svc.tick();
        assertThat(boards.fetches).hasSize(1);

        clock.advance(Duration.ofSeconds(59)); // 12:15:00: 15 minutes since that fetch
        svc.tick();
        assertThat(boards.fetches).hasSize(2);
    }

    @Test
    void aBlankedCandidate_isStillMatchedAgainstAFresherBoardAnotherCandidateFetches() {
        Instant td = now.minus(Duration.ofMinutes(10));
        addInferred("a1", "SAS1", "ESSA", td);
        boards.boards.put("ESSA", List.of());
        ArrivalConfirmationService svc = service(boards);
        svc.tick(); // a1 is not on the board
        assertThat(boards.fetches).hasSize(1);

        clock.advance(Duration.ofSeconds(301)); // stale; a1 may not trigger a refetch, a newcomer may
        addInferred("a2", "SAS2", "ESSA", td.plusSeconds(60));
        boards.boards.put("ESSA", List.of(entry("SAS1", null, td, null, null), entry("SAS2", null, td.plusSeconds(60), null, null)));
        svc.tick();
        assertThat(boards.fetches).hasSize(2);
        assertThat(store.forAircraft(aircraft.get("a2"))).isPresent();

        clock.advance(Duration.ofSeconds(30));
        svc.tick(); // a1 meets the fresher board for free
        assertThat(boards.fetches).hasSize(2);
        assertThat(store.forAircraft(aircraft.get("a1"))).isPresent();
    }

    @Test
    void anAircraftWaitingForItsGate_isRechecked_atMostOncePerRecheckInterval() {
        Instant td = now.minus(Duration.ofMinutes(10));
        addInferred("a1", "SAS1", "ESSA", td);
        boards.boards.put("ESSA", List.of(entry("SAS1", null, td, null, null)));
        ArrivalConfirmationService svc = service(boards);
        svc.tick(); // landing confirmed from the first board
        assertThat(boards.fetches).hasSize(1);

        clock.advance(Duration.ofSeconds(301));
        svc.tick(); // asked for the gate once: the board has none
        assertThat(boards.fetches).hasSize(2);

        clock.advance(Duration.ofSeconds(301));
        svc.tick();
        clock.advance(Duration.ofSeconds(301));
        svc.tick();
        assertThat(boards.fetches).hasSize(2); // 10 min since the last fetch: not yet

        boards.boards.put("ESSA", List.of(entry("SAS1", null, td, td.plusSeconds(480), "B14")));
        clock.advance(Duration.ofMinutes(5)); // 15 min after the second fetch
        svc.tick();
        assertThat(boards.fetches).hasSize(3);
        assertThat(store.forAircraft(aircraft.get("a1")).orElseThrow().gateAt()).isEqualTo(td.plusSeconds(480));
    }

    @Test
    void aSkippedFetch_doesNotEndTheTick_laterCandidatesStillMatchFreshCachedBoards() {
        Instant td = now.minus(Duration.ofMinutes(10));
        addInferred("x1", "SAS1", "ESSA", td);                       // sorts first; its ESSA board is missing
        addInferred("y1", "SAS2", "ESGG", td.plusSeconds(60));       // ESGG has a fresh cached board
        boards.boards.put("ESGG", List.of(entry("SAS2", null, td.plusSeconds(60), null, null)));
        ConfirmationGateway gateway = new ConfirmationGateway(clock, 0, InMemoryAppState.budgets(clock, 300), 1000, 300, 60, 300, 100);
        LocalDate date = LocalDate.parse("2026-10-12");
        gateway.board(boards, "ESGG", date);                         // caches the ESGG board
        boards.override = BoardResult.failed();
        gateway.board(boards, "ESSA", date);                         // fails: the provider now cools down
        assertThat(boards.fetches).hasSize(2);
        ArrivalConfirmationService svc = new ArrivalConfirmationService(List.of(), List.of(boards), aircraftRepository, gateway, store,
                live, routes, runways, training, clock, 0.5, 120, 300, 45, 15);

        svc.tick();

        assertThat(boards.fetches).hasSize(2); // the gateway was not asked for anything real
        assertThat(store.forAircraft(aircraft.get("x1"))).isEmpty();
        assertThat(store.forAircraft(aircraft.get("y1"))).isPresent();
    }

    @Test
    void aNewCandidate_isMatchedAgainstTheCachedBoardWithoutACall() {
        Instant td = now.minus(Duration.ofMinutes(10));
        boards.boards.put("ESSA", List.of(entry("SAS1", null, td, null, null), entry("SAS2", null, td, null, null)));
        addInferred("a1", "SAS1", "ESSA", td);
        ArrivalConfirmationService svc = service(boards);
        svc.tick();

        addInferred("a2", "SAS2", "ESSA", td);
        clock.advance(Duration.ofSeconds(60));
        svc.tick();

        assertThat(boards.fetches).hasSize(1);
        assertThat(store.size()).isEqualTo(2);
    }

    @Test
    void noFetchWhenNobodyNeedsConfirming_orTheAirportIsNotCovered_orTheProviderIsOff() {
        service(boards).tick(); // no candidates
        assertThat(boards.fetches).isEmpty();

        addInferred("a1", "SAS1", "ESSA", now.minusSeconds(300));
        boards.airports = List.of("ESGG");
        service(boards).tick();
        assertThat(boards.fetches).isEmpty();

        boards.airports = null;
        boards.enabled = false;
        service(boards).tick();
        assertThat(boards.fetches).isEmpty();
    }

    @Test
    void aConfirmedAircraftWithAGate_isNotACandidate_soNothingIsFetchedForIt() {
        Instant td = now.minus(Duration.ofMinutes(10));
        addInferred("a1", "SAS1", "ESSA", td);
        boards.boards.put("ESSA", List.of(entry("SAS1", null, td, td.plusSeconds(480), "B14")));
        ArrivalConfirmationService svc = service(boards);
        svc.tick();
        assertThat(boards.fetches).hasSize(1);

        clock.advance(Duration.ofMinutes(10));
        svc.tick();

        assertThat(boards.fetches).hasSize(1);
    }

    // ---- matching

    @Test
    void callsigns_areMatchedTrimmedAndUpperCase() {
        Instant td = now.minus(Duration.ofMinutes(10));
        addInferred("a1", " sas1 ", "ESSA", td);
        boards.boards.put("ESSA", List.of(entry("SAS1", null, td, null, null)));

        service(boards).tick();

        assertThat(store.size()).isEqualTo(1);
    }

    @Test
    void whenTheCallsignDoesNotMatch_theRegistrationIsTheFallback() {
        Instant td = now.minus(Duration.ofMinutes(10));
        addInferred("a1", "SAS1", "ESSA", td);
        when(aircraftRepository.findById("a1")).thenReturn(Optional.of(withRegistration("a1", "se-rua")));
        boards.boards.put("ESSA", List.of(
                entry("SK9999", "SE-RUB", td, null, null),
                entry("SAS1X", "SERUA", td, null, "C3")));

        service(boards).tick();

        assertThat(store.forAircraft(aircraft.get("a1")).orElseThrow().info().gate()).isEqualTo("C3");
    }

    @Test
    void noRegistrationOnEitherSide_meansNoFallback() {
        Instant td = now.minus(Duration.ofMinutes(10));
        addInferred("a1", "SAS1", "ESSA", td);
        addInferred("a2", "SAS2", "ESSA", td);
        when(aircraftRepository.findById("a2")).thenReturn(Optional.of(withRegistration("a2", null)));
        boards.boards.put("ESSA", List.of(entry("OTHER", "SE-RUA", td, null, null)));

        service(boards).tick();

        assertThat(store.size()).isZero();
    }

    @Test
    void theRegistrationIsNotLookedUpWhenTheBoardHasNone() {
        Instant td = now.minus(Duration.ofMinutes(10));
        addInferred("a1", "SAS1", "ESSA", td);
        boards.boards.put("ESSA", List.of(entry("OTHER", null, td, null, null)));

        service(boards).tick();

        verify(aircraftRepository, never()).findById(anyString());
    }

    @Test
    void anEntryWithoutActualTimes_confirmsNothing() {
        addInferred("a1", "SAS1", "ESSA", now.minusSeconds(300));
        boards.boards.put("ESSA", List.of(entry("SAS1", null, null, null, "A1")));

        service(boards).tick();

        assertThat(store.size()).isZero();
    }

    @Test
    void anEarlierLegOfTheSameCallsign_isIgnored_andTheNearestLegWinsWhenBothAreOnTheBoard() {
        Instant td = now.minus(Duration.ofMinutes(10));
        addInferred("a1", "SES1", "ESSA", td);
        boards.boards.put("ESSA", List.of(
                entry("SES1", null, td.minus(Duration.ofHours(3)), td.minus(Duration.ofHours(3)).plusSeconds(480), "OLD"),
                entry("SES1", null, td.plusSeconds(30), null, null)));

        service(boards).tick();
        assertThat(store.forAircraft(aircraft.get("a1")).orElseThrow().info().gate()).isNull();
        assertThat(store.forAircraft(aircraft.get("a1")).orElseThrow().landedAt()).isEqualTo(td.plusSeconds(30));
    }

    @Test
    void aBoardThatOnlyHasAnEarlierLeg_isRejectedByTheSkewTolerance() {
        Instant td = now.minus(Duration.ofMinutes(10));
        addInferred("a1", "SES1", "ESSA", td);
        boards.boards.put("ESSA", List.of(
                entry("SES1", null, td.minus(Duration.ofHours(3)), td.minus(Duration.ofHours(3)).plusSeconds(480), "OLD")));

        service(boards).tick();

        assertThat(store.size()).isZero();
    }

    // ---- shared rules

    @Test
    void atMostOneRealCallPerTick_candidatesAtAnotherAirportWaitForTheNextTick() {
        Instant td = now.minus(Duration.ofMinutes(10));
        addInferred("a1", "SAS1", "ESSA", td);
        addInferred("a2", "SAS2", "ESGG", td.plusSeconds(60));
        addInferred("a3", "SAS3", "ESSA", td.plusSeconds(120));
        boards.boards.put("ESSA", List.of(entry("SAS1", null, td, null, null), entry("SAS3", null, td, null, null)));
        boards.boards.put("ESGG", List.of(entry("SAS2", null, td, null, null)));
        ArrivalConfirmationService svc = service(boards);

        svc.tick();
        assertThat(boards.fetches).containsExactly("ESSA@2026-10-12");
        assertThat(store.size()).isEqualTo(2); // a1 and a3, from the one ESSA board

        svc.tick();
        assertThat(boards.fetches).containsExactly("ESSA@2026-10-12", "ESGG@2026-10-12");
        assertThat(store.size()).isEqualTo(3);
    }

    @Test
    void aThrottledBoard_confirmsNothing_andIsNotCached() {
        addInferred("a1", "SAS1", "ESSA", now.minusSeconds(300));
        boards.override = BoardResult.throttled(Duration.ofMinutes(10));
        ArrivalConfirmationService svc = service(boards);

        svc.tick();
        svc.tick(); // cooling down: skipped

        assertThat(boards.fetches).hasSize(1);
        assertThat(store.size()).isZero();
    }

    @Test
    void aGateComesLater_theConfirmedAircraftIsAskedAgainWhenTheBoardIsStale() {
        Instant td = now.minus(Duration.ofMinutes(10));
        addInferred("a1", "SAS1", "ESSA", td);
        boards.boards.put("ESSA", List.of(entry("SAS1", null, td, null, null)));
        ArrivalConfirmationService svc = service(boards);
        svc.tick();
        assertThat(store.forAircraft(aircraft.get("a1")).orElseThrow().gateAt()).isNull();

        boards.boards.put("ESSA", List.of(entry("SAS1", null, td, td.plusSeconds(480), "B14")));
        clock.advance(Duration.ofSeconds(301));
        svc.tick();

        assertThat(boards.fetches).hasSize(2);
        assertThat(store.forAircraft(aircraft.get("a1")).orElseThrow().gateAt()).isEqualTo(td.plusSeconds(480));
    }

    @Test
    void aPerFlightProviderAndABoardProvider_workSideBySide() {
        Instant td = now.minus(Duration.ofMinutes(10));
        addInferred("a1", "SAS1", "ESSA", td);
        List<ArrivalQuery> perFlightCalls = new ArrayList<>();
        ArrivalConfirmationProvider perFlight = new ArrivalConfirmationProvider() {
            @Override public String id() { return "flight"; }
            @Override public boolean covers(String airport) { return true; }
            @Override public LookupResult lookup(ArrivalQuery query) {
                perFlightCalls.add(query);
                return LookupResult.notFound();
            }
        };
        boards.boards.put("ESSA", List.of(entry("SAS1", null, td, null, null)));
        ConfirmationGateway gateway = new ConfirmationGateway(clock, 0, InMemoryAppState.budgets(clock, 300), 1000, 300, 60, 300, 100);
        ArrivalConfirmationService svc = new ArrivalConfirmationService(List.of(perFlight), List.of(boards), aircraftRepository,
                gateway, store, live, routes, runways, training, clock, 0.5, 120, 300, 45, 15);

        svc.tick();

        assertThat(perFlightCalls).hasSize(1);
        assertThat(boards.fetches).hasSize(1);
        assertThat(store.forAircraft(aircraft.get("a1")).orElseThrow().providerId()).isEqualTo("sw");
    }

    @Test
    void aServiceWithoutBoardProviders_acceptsNull() {
        ConfirmationGateway gateway = new ConfirmationGateway(clock, 0, InMemoryAppState.budgets(clock, 300), 1000, 300, 60, 300, 100);
        ArrivalConfirmationService svc = new ArrivalConfirmationService(List.of(), null, aircraftRepository,
                gateway, store, live, routes, runways, training, clock, 0.5, 120, 300, 45, 15);
        addInferred("a1", "SAS1", "ESSA", now.minusSeconds(300));

        svc.tick();

        assertThat(store.size()).isZero();
    }
}
