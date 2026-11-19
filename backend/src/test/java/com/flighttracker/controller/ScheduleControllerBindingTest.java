package com.flighttracker.controller;

import com.flighttracker.service.live.LiveStateStore;
import com.flighttracker.service.schedule.FlightScheduleService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import java.time.LocalDate;
import java.util.List;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/** The /api/schedule/search parameters bind from the query string only, by their exact names. */
class ScheduleControllerBindingTest {

    private static final LocalDate TODAY = LocalDate.of(2026, 11, 19);

    private final FlightScheduleService schedule = mock(FlightScheduleService.class);
    private final MockMvc mvc = MockMvcBuilders
            .standaloneSetup(new ScheduleController(schedule, mock(LiveStateStore.class)))
            .build();

    @BeforeEach
    void setUp() {
        when(schedule.available()).thenReturn(true);
        when(schedule.today()).thenReturn(TODAY);
    }

    @Test
    void bindsFlightAirportAndDate() throws Exception {
        LocalDate day = LocalDate.of(2026, 11, 20);
        when(schedule.byFlightNumber(eq("BA778"), eq(day), eq(List.of("ARN", "GOT")), any())).thenReturn(List.of());

        mvc.perform(get("/api/schedule/search").param("flight", "BA778").param("airport", "ARN,GOT")
                        .param("date", "2026-11-20"))
                .andExpect(status().isOk())
                .andExpect(header().string(ScheduleController.STATUS_HEADER, "ok"));
        verify(schedule).byFlightNumber(eq("BA778"), eq(day), eq(List.of("ARN", "GOT")), any());
    }

    @Test
    void bindsFromAndToOnTodayByDefault() throws Exception {
        when(schedule.byRoute(eq(List.of("LHR", "LGW")), eq(List.of("ARN")), eq(TODAY), any())).thenReturn(List.of());

        mvc.perform(get("/api/schedule/search").param("from", "LHR,LGW").param("to", "ARN"))
                .andExpect(status().isOk());
        verify(schedule).byRoute(eq(List.of("LHR", "LGW")), eq(List.of("ARN")), eq(TODAY), any());
    }

    @Test
    void noParametersIsABadRequest() throws Exception {
        mvc.perform(get("/api/schedule/search")).andExpect(status().isBadRequest());
    }

    @Test
    void aMalformedDateIsABadRequest() throws Exception {
        mvc.perform(get("/api/schedule/search").param("flight", "BA778").param("date", "19/11/2026"))
                .andExpect(status().isBadRequest());
    }

    @Test
    void aDateHeaderDoesNotSetTheDate() throws Exception {
        when(schedule.byFlightNumber(eq("BA778"), eq(TODAY), eq(List.of()), any())).thenReturn(List.of());

        mvc.perform(get("/api/schedule/search").param("flight", "BA778")
                        .header("Date", "Thu, 19 Nov 2026 10:00:00 GMT"))
                .andExpect(status().isOk());
        verify(schedule).byFlightNumber(eq("BA778"), eq(TODAY), eq(List.of()), any());
    }

    @Test
    void aFlightHeaderIsNotAFlightNumber() throws Exception {
        mvc.perform(get("/api/schedule/search").header("Flight", "SK1")).andExpect(status().isBadRequest());
        verify(schedule, never()).byFlightNumber(any(), any(), any(), any());
    }

    @Test
    void binderPrefixedAndIndexedNamesAreIgnored() throws Exception {
        mvc.perform(get("/api/schedule/search").param("!flight", "BA778")).andExpect(status().isBadRequest());
        mvc.perform(get("/api/schedule/search").param("_flight", "BA778")).andExpect(status().isBadRequest());
        mvc.perform(get("/api/schedule/search").param("flight[0]", "x")).andExpect(status().isBadRequest());
        verify(schedule, never()).byFlightNumber(any(), any(), any(), any());
    }
}
