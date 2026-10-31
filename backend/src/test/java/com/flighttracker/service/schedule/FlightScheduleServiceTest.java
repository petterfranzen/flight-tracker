package com.flighttracker.service.schedule;

import com.flighttracker.service.confirmation.SwedaviaArrivalsProvider;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/** The flight search against a mocked Swedavia board; nothing leaves the JVM. */
class FlightScheduleServiceTest {

    static final LocalDate DAY = LocalDate.parse("2026-11-02");

    private SwedaviaArrivalsProvider swedavia;
    private FlightScheduleService service;

    @BeforeEach
    void setUp() throws IOException {
        String body = new String(getClass().getResourceAsStream("/swedavia/arn-arrivals-search.json").readAllBytes(), StandardCharsets.UTF_8);
        swedavia = mock(SwedaviaArrivalsProvider.class);
        when(swedavia.enabled()).thenReturn(true);
        when(swedavia.servesIata(any())).thenAnswer(i -> List.of("ARN", "BMA", "GOT").contains(i.getArgument(0)));
        when(swedavia.fetchBoardBody(any(), any(), any())).thenReturn(Optional.empty());
        when(swedavia.fetchBoardBody("ARN", "arrivals", DAY)).thenReturn(Optional.of(body));
        service = new FlightScheduleService(swedavia, Clock.fixed(Instant.parse("2026-11-01T12:00:00Z"), ZoneOffset.UTC));
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
}
