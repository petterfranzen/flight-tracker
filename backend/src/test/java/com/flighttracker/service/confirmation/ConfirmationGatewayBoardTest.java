package com.flighttracker.service.confirmation;

import com.flighttracker.service.confirmation.ConfirmationGateway.Kind;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.mock.env.MockEnvironment;

import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;
import java.util.function.Supplier;

import static org.assertj.core.api.Assertions.assertThat;

/** The board cache, and the pacing, budgets and backoff that apply to a board provider. */
class ConfirmationGatewayBoardTest {

    private static final LocalDate TODAY = LocalDate.parse("2026-10-12");

    private static final class FakeBoards implements AirportArrivalsProvider {
        final String id;
        final List<String> calls = new ArrayList<>();
        Supplier<BoardResult> answer = () -> BoardResult.found(List.of());

        FakeBoards(String id) {
            this.id = id;
        }

        @Override public String id() { return id; }
        @Override public boolean covers(String airport) { return true; }
        @Override public BoardResult fetchArrivals(String airport, LocalDate dateUtc) {
            calls.add(airport + "@" + dateUtc);
            return answer.get();
        }
    }

    private TestClock clock;
    private MockEnvironment env;
    private FakeBoards provider;

    @BeforeEach
    void setUp() {
        clock = new TestClock();
        clock.set(Instant.parse("2026-10-12T10:00:00Z"));
        env = new MockEnvironment();
        provider = new FakeBoards("sw");
    }

    private ConfirmationGateway gateway(int maxBoards) {
        ConfirmationBudgets budgets = new ConfirmationBudgets(new InMemoryAppState(clock), clock, env,
                new com.flighttracker.observability.PhaseLogger(), 300);
        return new ConfirmationGateway(clock, 30, budgets, 100, 300, 60, 300, maxBoards);
    }

    @Test
    void aBoardIsCachedPerProviderAirportAndDate_forTheTtl() {
        ConfirmationGateway gw = gateway(100);

        assertThat(gw.board(provider, "ESSA", TODAY).kind()).isEqualTo(Kind.CALLED);
        assertThat(gw.board(provider, "essa ", TODAY).kind()).isEqualTo(Kind.CACHED);
        assertThat(provider.calls).containsExactly("ESSA@2026-10-12");

        clock.advance(Duration.ofSeconds(31));
        assertThat(gw.board(provider, "ESGG", TODAY).kind()).isEqualTo(Kind.CALLED);
        clock.advance(Duration.ofSeconds(31));
        assertThat(gw.board(provider, "ESSA", TODAY.plusDays(1)).kind()).isEqualTo(Kind.CALLED);
        clock.advance(Duration.ofSeconds(31));
        assertThat(gw.board(new FakeBoards("other"), "ESSA", TODAY).kind()).isEqualTo(Kind.CALLED);
        assertThat(provider.calls).hasSize(3);
    }

    @Test
    void aBoardIsFreshForBoardTtlSeconds_thenFetchedAgain() {
        ConfirmationGateway gw = gateway(100);
        gw.board(provider, "ESSA", TODAY);

        clock.advance(Duration.ofSeconds(299));
        assertThat(gw.board(provider, "ESSA", TODAY).kind()).isEqualTo(Kind.CACHED);
        clock.advance(Duration.ofSeconds(2));
        assertThat(gw.cachedBoard(provider, "ESSA", TODAY)).isEmpty();
        assertThat(gw.board(provider, "ESSA", TODAY).kind()).isEqualTo(Kind.CALLED);
        assertThat(provider.calls).hasSize(2);
    }

    @Test
    void cachedBoard_neverCalls() {
        ConfirmationGateway gw = gateway(100);

        assertThat(gw.cachedBoard(provider, "ESSA", TODAY)).isEmpty();
        assertThat(provider.calls).isEmpty();
        gw.board(provider, "ESSA", TODAY);
        assertThat(gw.cachedBoard(provider, "ESSA", TODAY)).isPresent();
        assertThat(provider.calls).hasSize(1);
    }

    @Test
    void notFoundIsCachedToo_butThrottledAndFailedAreNot() {
        ConfirmationGateway gw = gateway(100);
        provider.answer = BoardResult::notFound;
        gw.board(provider, "ESSA", TODAY);
        assertThat(gw.board(provider, "ESSA", TODAY).kind()).isEqualTo(Kind.CACHED);

        provider.answer = BoardResult::failed;
        clock.advance(Duration.ofSeconds(301));
        assertThat(gw.board(provider, "ESSA", TODAY).board().status()).isEqualTo(LookupResult.Status.FAILED);
        assertThat(gw.cachedBoard(provider, "ESSA", TODAY)).isEmpty();
    }

    @Test
    void minimumInterval_appliesToBoardFetches_perProvider() {
        ConfirmationGateway gw = gateway(100);
        gw.board(provider, "ESSA", TODAY);

        clock.advance(Duration.ofSeconds(29));
        assertThat(gw.board(provider, "ESGG", TODAY).kind()).isEqualTo(Kind.SKIPPED);
        assertThat(gw.board(new FakeBoards("other"), "ESGG", TODAY).kind()).isEqualTo(Kind.CALLED);
        clock.advance(Duration.ofSeconds(1));
        assertThat(gw.board(provider, "ESGG", TODAY).kind()).isEqualTo(Kind.CALLED);
    }

    @Test
    void throttled_backsOffWithRetryAfter_thenTriesAgain() {
        // PollBackoff stamps its cool-down with the system clock, so this test runs on real time
        Instant realNow = Instant.now();
        clock.set(realNow);
        ConfirmationGateway gw = gateway(100);
        provider.answer = () -> BoardResult.throttled(Duration.ofMinutes(10));
        assertThat(gw.board(provider, "ESSA", TODAY).kind()).isEqualTo(Kind.CALLED);

        clock.set(realNow.plus(Duration.ofMinutes(9)));
        assertThat(gw.board(provider, "ESSA", TODAY).kind()).isEqualTo(Kind.SKIPPED);
        clock.set(realNow.plus(Duration.ofMinutes(11)));
        provider.answer = () -> BoardResult.found(List.of());
        assertThat(gw.board(provider, "ESSA", TODAY).kind()).isEqualTo(Kind.CALLED);
        assertThat(provider.calls).hasSize(2);
    }

    @Test
    void aProviderThatThrows_isTreatedAsFailed() {
        ConfirmationGateway gw = gateway(100);
        provider.answer = () -> {
            throw new IllegalStateException("boom");
        };

        ConfirmationGateway.BoardOutcome o = gw.board(provider, "ESSA", TODAY);

        assertThat(o.kind()).isEqualTo(Kind.CALLED);
        assertThat(o.board().status()).isEqualTo(LookupResult.Status.FAILED);
    }

    @Test
    void aFetchIsChargedItsCostUnits_andTheBudgetsStopFurtherFetches() {
        env.setProperty("flighttracker.confirmation.providers.sw.monthly-budget", "5");
        ConfirmationGateway gw = gateway(100);
        provider.answer = () -> BoardResult.found(List.of()).withCost(3);

        gw.board(provider, "ESSA", TODAY);
        assertThat(gw.unitsToday("sw")).isEqualTo(3);
        assertThat(gw.unitsThisMonth("sw")).isEqualTo(3);

        clock.advance(Duration.ofSeconds(31));
        assertThat(gw.board(provider, "ESGG", TODAY).kind()).isEqualTo(Kind.CALLED); // 1 unit reserved, 3 real: 6 of 5
        clock.advance(Duration.ofSeconds(31));
        assertThat(gw.board(provider, "ESGL", TODAY).kind()).isEqualTo(Kind.SKIPPED);
        assertThat(provider.calls).hasSize(2);
    }

    @Test
    void aCheapCall_isRefunded() {
        ConfirmationGateway gw = gateway(100);
        provider.answer = () -> BoardResult.throttled(null).withCost(0);

        gw.board(provider, "ESSA", TODAY);

        assertThat(gw.unitsToday("sw")).isZero();
    }

    @Test
    void theBoardCacheIsBounded() {
        ConfirmationGateway gw = gateway(2);
        for (String airport : List.of("ESSA", "ESGG", "ESGL", "ESMS")) {
            gw.board(provider, airport, TODAY);
            clock.advance(Duration.ofSeconds(31));
        }

        assertThat(gw.boardCacheSize()).isEqualTo(2);
    }

    @Test
    void perFlightLookups_chargeCallCostUnits() {
        ConfirmationGateway gw = gateway(100);
        env.setProperty("flighttracker.confirmation.providers.adb.daily-budget", "5");
        ArrivalConfirmationProvider costly = new ArrivalConfirmationProvider() {
            @Override public String id() { return "adb"; }
            @Override public boolean covers(String airport) { return true; }
            @Override public LookupResult lookup(ArrivalQuery query) { return LookupResult.notFound(); }
            @Override public int callCost() { return 2; }
        };
        Instant landed = clock.instant();

        assertThat(gw.lookup(costly, new ArrivalQuery("a", "A1", "ESSA", landed)).kind()).isEqualTo(Kind.CALLED);
        clock.advance(Duration.ofSeconds(31));
        assertThat(gw.lookup(costly, new ArrivalQuery("a", "A2", "ESSA", landed)).kind()).isEqualTo(Kind.CALLED);
        clock.advance(Duration.ofSeconds(31));
        assertThat(gw.lookup(costly, new ArrivalQuery("a", "A3", "ESSA", landed)).kind()).isEqualTo(Kind.SKIPPED); // 4 + 2 > 5
        assertThat(gw.unitsToday("adb")).isEqualTo(4);
    }
}
