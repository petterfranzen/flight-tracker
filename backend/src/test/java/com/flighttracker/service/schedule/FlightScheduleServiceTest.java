package com.flighttracker.service.schedule;

import com.flighttracker.service.confirmation.ConfirmationBudgets;
import com.flighttracker.service.confirmation.SwedaviaArrivalsProvider;
import com.flighttracker.service.confirmation.SwedaviaArrivalsProvider.BoardFetch;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Duration;
import java.time.ZoneId;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/** The flight search against a mocked Swedavia board; nothing leaves the JVM. */
class FlightScheduleServiceTest {

    static final LocalDate DAY = LocalDate.parse("2026-11-02");

    private SwedaviaArrivalsProvider swedavia;
    private ConfirmationBudgets budgets;
    private MutableClock clock;
    private String body;
    private FlightScheduleService service;

    /** A clock the test can move. */
    static final class MutableClock extends Clock {
        Instant now = Instant.parse("2026-11-01T12:00:00Z");
        @Override public ZoneId getZone() { return ZoneOffset.UTC; }
        @Override public Clock withZone(ZoneId zone) { return this; }
        @Override public Instant instant() { return now; }
    }

    private static BoardFetch ok(String body) { return new BoardFetch(body, false, null); }
    private static BoardFetch failure() { return new BoardFetch(null, true, null); }

    @BeforeEach
    void setUp() throws IOException {
        body = new String(getClass().getResourceAsStream("/swedavia/arn-arrivals-search.json").readAllBytes(), StandardCharsets.UTF_8);
        swedavia = mock(SwedaviaArrivalsProvider.class);
        when(swedavia.enabled()).thenReturn(true);
        when(swedavia.servesIata(any())).thenAnswer(i -> List.of("ARN", "BMA", "GOT").contains(i.getArgument(0)));
        when(swedavia.fetchBoardBody(any(), any(), any())).thenReturn(new BoardFetch(null, false, null));
        when(swedavia.fetchBoardBody("ARN", "arrivals", DAY)).thenReturn(ok(body));
        when(swedavia.fetchBoardBody("ARN", "departures", DAY)).thenReturn(ok("{\"flights\":[]}"));
        budgets = mock(ConfirmationBudgets.class);
        when(budgets.tryCharge(any(), org.mockito.ArgumentMatchers.anyInt())).thenReturn(true);
        clock = new MutableClock();
        service = new FlightScheduleService(swedavia, budgets, clock);
    }

    @Test
    void findsAFlightNumberWithTimesGateStatusAndDerivedCallsign() {
        List<ScheduledFlight> found = service.byFlightNumber("ba 778", DAY, List.of("ARN"));

        assertThat(found).hasSize(1);
        ScheduledFlight f = found.get(0);
        assertThat(f.flightNumber()).isEqualTo("BA778");
        assertThat(f.callsign()).isEqualTo("BAW778"); // from the board's airline ICAO
        assertThat(f.departureIata()).isEqualTo("LHR");
        assertThat(f.arrivalIata()).isEqualTo("ARN");
        assertThat(f.scheduled()).isEqualTo(Instant.parse("2026-11-02T10:05:00Z"));
        assertThat(f.estimated()).isEqualTo(Instant.parse("2026-11-02T10:20:00Z"));
        assertThat(f.gate()).isEqualTo("F12");
        assertThat(f.status()).isEqualTo("Scheduled");
        assertThat(f.airborne()).isFalse();
    }

    @Test
    void usesSwedaviasCallsignWhenGivenAndTheAirlinePrefixTableOtherwise() {
        assertThat(service.byFlightNumber("SK590", DAY, List.of("ARN")).get(0).callsign()).isEqualTo("SAS590");
        assertThat(service.byFlightNumber("AY123", DAY, List.of("ARN")).get(0).callsign()).isEqualTo("FIN123"); // table
        assertThat(service.byFlightNumber("SK590", DAY, List.of("ARN")).get(0).status()).isEqualTo("Landed");
    }

    @Test
    void routeSearchKeepsOnlyTheNamedOriginsAndSortsByTime() {
        List<ScheduledFlight> found = service.byRoute(List.of("LHR", "LGW", "LCY"), List.of("ARN"), DAY);

        assertThat(found).extracting(ScheduledFlight::flightNumber).containsExactly("SK590", "BA778");
    }

    @Test
    void routeToANonSwedaviaAirportFromANonSwedaviaAirportFindsNothingWithoutCalling() {
        assertThat(service.byRoute(List.of("LHR"), List.of("CDG"), DAY)).isEmpty();
        verify(swedavia, times(0)).fetchBoardBody(any(), any(), any());
    }

    @Test
    void cachesABoardSoRepeatedSearchesCostOneCall() {
        service.byFlightNumber("BA778", DAY, List.of("ARN"));
        service.byFlightNumber("SK590", DAY, List.of("ARN"));

        verify(swedavia, times(1)).fetchBoardBody(eq("ARN"), eq("arrivals"), eq(DAY));
    }

    // ---- budget, pacing, backoff

    @Test
    void everyRealCallIsChargedToTheScheduleBudget_andARefusedChargeMeansNoCall() {
        service.byFlightNumber("BA778", DAY, List.of("ARN"));
        verify(budgets, times(2)).tryCharge(FlightScheduleService.BUDGET_ID, 1); // arrivals + departures

        when(budgets.tryCharge(any(), org.mockito.ArgumentMatchers.anyInt())).thenReturn(false);
        FlightScheduleService.Outcome outcome = new FlightScheduleService.Outcome();
        assertThat(service.byFlightNumber("BA778", DAY, List.of("BMA"), outcome)).isEmpty();

        verify(swedavia, never()).fetchBoardBody(eq("BMA"), any(), any());
        assertThat(outcome.status()).isEqualTo("incomplete");
    }

    @Test
    void aNothingWasAskedAnswerRefundsItsCharge() {
        service.byFlightNumber("BA778", DAY, List.of("BMA"));

        verify(budgets, times(2)).adjust(FlightScheduleService.BUDGET_ID, -1);
    }

    @Test
    void aBurstOfSearchesIsPacedByTheTokenBucket() {
        FlightScheduleService.Outcome outcome = new FlightScheduleService.Outcome();
        // 3 airports x 2 directions = 6 calls: the whole burst. The next date has no tokens left.
        service.byFlightNumber("BA778", DAY, List.of("ARN", "BMA", "GOT"), outcome);
        assertThat(outcome.status()).isEqualTo("ok");
        verify(swedavia, times(FlightScheduleService.BURST)).fetchBoardBody(any(), any(), any());

        FlightScheduleService.Outcome next = new FlightScheduleService.Outcome();
        service.byFlightNumber("BA778", DAY.plusDays(1), List.of("ARN"), next);
        verify(swedavia, times(FlightScheduleService.BURST)).fetchBoardBody(any(), any(), any());
        assertThat(next.status()).isEqualTo("incomplete");

        clock.now = clock.now.plus(FlightScheduleService.REFILL.multipliedBy(2));
        service.byFlightNumber("BA778", DAY.plusDays(1), List.of("ARN"));
        verify(swedavia, times(FlightScheduleService.BURST + 2)).fetchBoardBody(any(), any(), any());
    }

    @Test
    void whenSwedaviaFailsItIsLeftAloneWithGrowingBackoffAndRecoversOnSuccess() {
        when(swedavia.fetchBoardBody("ARN", "arrivals", DAY)).thenReturn(failure());
        FlightScheduleService.Outcome outcome = new FlightScheduleService.Outcome();

        assertThat(service.byFlightNumber("BA778", DAY, List.of("ARN"), outcome)).isEmpty();
        assertThat(outcome.status()).isEqualTo("incomplete");
        verify(swedavia, times(1)).fetchBoardBody(any(), any(), any()); // the departures board was not tried

        clock.now = clock.now.plus(FlightScheduleService.BACKOFF_BASE.minusSeconds(1));
        service.byFlightNumber("BA778", DAY, List.of("ARN"));
        verify(swedavia, times(1)).fetchBoardBody(any(), any(), any()); // still backing off

        clock.now = clock.now.plusSeconds(1);
        service.byFlightNumber("BA778", DAY, List.of("ARN")); // fails again: backoff doubles
        verify(swedavia, times(2)).fetchBoardBody(any(), any(), any());
        clock.now = clock.now.plus(FlightScheduleService.BACKOFF_BASE.multipliedBy(2).minusSeconds(1));
        service.byFlightNumber("BA778", DAY, List.of("ARN"));
        verify(swedavia, times(2)).fetchBoardBody(any(), any(), any());

        when(swedavia.fetchBoardBody("ARN", "arrivals", DAY)).thenReturn(ok(body));
        clock.now = clock.now.plusSeconds(1);
        assertThat(service.byFlightNumber("BA778", DAY, List.of("ARN"))).hasSize(1);
    }

    @Test
    void aRetryAfterLongerThanTheBackoffIsHonoured() {
        when(swedavia.fetchBoardBody("ARN", "arrivals", DAY)).thenReturn(new BoardFetch(null, true, Duration.ofMinutes(5)));
        service.byFlightNumber("BA778", DAY, List.of("ARN"));

        clock.now = clock.now.plus(Duration.ofMinutes(4));
        service.byFlightNumber("BA778", DAY, List.of("ARN"));
        verify(swedavia, times(1)).fetchBoardBody(any(), any(), any());
    }

    @Test
    void aFailedRefreshServesTheStaleBoardAndSaysSo() {
        assertThat(service.byFlightNumber("BA778", DAY, List.of("ARN"))).hasSize(1);
        when(swedavia.fetchBoardBody("ARN", "arrivals", DAY)).thenReturn(failure());
        clock.now = clock.now.plus(FlightScheduleService.TTL).plusSeconds(1);

        FlightScheduleService.Outcome outcome = new FlightScheduleService.Outcome();
        assertThat(service.byFlightNumber("BA778", DAY, List.of("ARN"), outcome)).hasSize(1);
        assertThat(outcome.status()).isEqualTo("stale");
    }

    // ---- malformed boards

    @Test
    void aMalformedBoardIsAnEmptyIncompleteAnswerNotAnException() {
        when(swedavia.fetchBoardBody("ARN", "arrivals", DAY)).thenReturn(ok("{\"flights\": [ {\"flightId\": \"BA77"));
        FlightScheduleService.Outcome outcome = new FlightScheduleService.Outcome();

        assertThat(service.byFlightNumber("BA778", DAY, List.of("ARN"), outcome)).isEmpty();
        assertThat(outcome.status()).isEqualTo("incomplete");
    }

    @Test
    void aMalformedBoardIsNotCachedAndNotRefetchedForAMinute_thenTriedAgain() {
        when(swedavia.fetchBoardBody("ARN", "arrivals", DAY)).thenReturn(ok("not json"));
        service.byFlightNumber("BA778", DAY, List.of("ARN"));
        service.byFlightNumber("BA778", DAY, List.of("ARN"));
        verify(swedavia, times(1)).fetchBoardBody(eq("ARN"), eq("arrivals"), eq(DAY));

        when(swedavia.fetchBoardBody("ARN", "arrivals", DAY)).thenReturn(ok(body));
        clock.now = clock.now.plus(FlightScheduleService.BAD_BOARD_PAUSE).plusSeconds(1);
        assertThat(service.byFlightNumber("BA778", DAY, List.of("ARN"))).hasSize(1);
    }

    @Test
    void aMalformedRefreshKeepsServingTheStaleBoard() {
        service.byFlightNumber("BA778", DAY, List.of("ARN"));
        when(swedavia.fetchBoardBody("ARN", "arrivals", DAY)).thenReturn(ok("{"));
        clock.now = clock.now.plus(FlightScheduleService.TTL).plusSeconds(1);

        FlightScheduleService.Outcome outcome = new FlightScheduleService.Outcome();
        assertThat(service.byFlightNumber("BA778", DAY, List.of("ARN"), outcome)).hasSize(1);
        assertThat(outcome.status()).isEqualTo("stale");
    }
}
