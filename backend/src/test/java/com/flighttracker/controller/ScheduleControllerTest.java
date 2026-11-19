package com.flighttracker.controller;

import com.flighttracker.controller.ScheduleController.SearchParams;
import com.flighttracker.model.FlightPosition;
import com.flighttracker.service.live.LiveStateStore;
import com.flighttracker.service.schedule.FlightScheduleService;
import com.flighttracker.service.schedule.ScheduledFlight;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.server.ResponseStatusException;

import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

class ScheduleControllerTest {

    private static final LocalDate TODAY = LocalDate.of(2026, 11, 19);

    private final FlightScheduleService schedule = mock(FlightScheduleService.class);
    private final LiveStateStore live = mock(LiveStateStore.class);
    private final ScheduleController controller = new ScheduleController(schedule, live);

    @BeforeEach
    void setUp() {
        when(schedule.available()).thenReturn(true);
        when(schedule.today()).thenReturn(TODAY);
    }

    @Test
    void unavailableWithoutAnApiKey() {
        when(schedule.available()).thenReturn(false);
        assertStatus(() -> controller.search(new SearchParams("BA778", null, null, null, null)), HttpStatus.SERVICE_UNAVAILABLE);
    }

    @Test
    void rejectsABadDateAndAMissingQuery() {
        assertStatus(() -> controller.search(new SearchParams("BA778", null, null, null, "19/11/2026")), HttpStatus.BAD_REQUEST);
        assertStatus(() -> controller.search(new SearchParams(" ", "LHR", null, null, null)), HttpStatus.BAD_REQUEST);
        assertStatus(() -> controller.search(new SearchParams(null, null, "ARN", null, null)), HttpStatus.BAD_REQUEST);
        verify(schedule, never()).byRoute(any(), any(), any(), any());
    }

    @Test
    void byFlightNumberOnTodayByDefault() {
        ScheduledFlight f = flight(null, null);
        when(schedule.byFlightNumber(eq("BA778"), eq(TODAY), eq(List.of("ARN", "GOT")), any())).thenReturn(List.of(f));

        ResponseEntity<List<ScheduledFlight>> r = controller.search(new SearchParams("BA778", "LHR", "ARN", " ARN, ,GOT ", "  "));
        assertThat(r.getBody()).containsExactly(f);
        assertThat(r.getHeaders().getFirst(ScheduleController.STATUS_HEADER)).isEqualTo("ok");
        verifyNoInteractions(live);
    }

    @Test
    void byRouteOnTheGivenDate() {
        when(schedule.byRoute(eq(List.of("LHR", "LGW")), eq(List.of("ARN")), eq(LocalDate.of(2026, 11, 20)), any()))
                .thenReturn(List.of());
        assertThat(controller.search(new SearchParams(null, "LHR,LGW", "ARN", null, " 2026-11-20 ")).getBody()).isEmpty();
    }

    @Test
    void linksTheLiveAircraftOnlyNearTheFlightsTime() {
        Instant soon = Instant.now().plus(Duration.ofHours(1));
        Instant far = Instant.now().plus(ScheduleController.MATCH_WINDOW).plus(Duration.ofHours(1));
        ScheduledFlight near = flight("BAW778", soon);
        ScheduledFlight later = flight("BAW778", far);
        ScheduledFlight noCallsign = flight(null, soon);
        when(schedule.byFlightNumber(eq("BA778"), eq(TODAY), eq(List.of()), any()))
                .thenReturn(List.of(near, later, noCallsign));
        when(live.searchByCallsign(eq("BAW778"), any(), any(), anyInt())).thenReturn(List.of(
                position("aaaaaa", "BAW7781", false),
                position("bbbbbb", "baw778", true),
                position("cccccc", "baw778", false)));

        List<ScheduledFlight> body = controller.search(new SearchParams("BA778", null, null, null, null)).getBody();
        assertThat(body).containsExactly(near.withLive("cccccc"), later, noCallsign);
    }

    private static ScheduledFlight flight(String callsign, Instant scheduled) {
        return new ScheduledFlight("BA778", callsign, "A", "ARN", "LHR", "ARN",
                scheduled, null, null, null, null, null, null, null, false);
    }

    private static FlightPosition position(String icao24, String callsign, boolean onGround) {
        return new FlightPosition(icao24, callsign, Instant.now(), 59.6, 17.9, 1000.0, 100.0, 0.0, 0.0, onGround, "test");
    }

    private static void assertStatus(Runnable call, HttpStatus status) {
        assertThatThrownBy(call::run).isInstanceOfSatisfying(ResponseStatusException.class,
                e -> assertThat(e.getStatusCode()).isEqualTo(status));
    }
}
