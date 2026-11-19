package com.flighttracker.controller;

import com.flighttracker.service.UsageService;
import org.junit.jupiter.api.Test;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.ResultMatcher;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import java.time.Duration;
import java.time.Instant;
import java.util.List;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/** The window rules on /api/usage: to after from, at most 24 h apart. */
class UsageControllerTest {

    private static final Instant FROM = Instant.parse("2026-11-18T06:00:00Z");

    private final UsageService service = mock(UsageService.class);
    private final MockMvc mvc = MockMvcBuilders.standaloneSetup(new UsageController(service)).build();

    private void expect(String query, ResultMatcher status) throws Exception {
        mvc.perform(get("/api/usage" + query)).andExpect(status);
    }

    private static String window(Instant from, Instant to) {
        return "?from=" + from + "&to=" + to;
    }

    @Test
    void exactly24HoursIsAllowed() throws Exception {
        when(service.usageForWindow(any(), any())).thenReturn(List.of());
        Instant to = FROM.plus(Duration.ofHours(24));
        mvc.perform(get("/api/usage" + window(FROM, to)))
                .andExpect(status().isOk())
                .andExpect(content().json("[]"));
        verify(service).usageForWindow(FROM, to);
    }

    @Test
    void oneHourIsAllowed() throws Exception {
        expect(window(FROM, FROM.plus(Duration.ofHours(1))), status().isOk());
    }

    @Test
    void longerThan24HoursIsRejected() throws Exception {
        expect(window(FROM, FROM.plus(Duration.ofHours(24)).plusMillis(1)), status().isBadRequest());
        expect(window(FROM, FROM.plus(Duration.ofHours(72))), status().isBadRequest());
        verify(service, never()).usageForWindow(any(), any());
    }

    @Test
    void toNotAfterFromIsRejected() throws Exception {
        expect(window(FROM, FROM), status().isBadRequest());
        expect(window(FROM, FROM.minusSeconds(1)), status().isBadRequest());
        verify(service, never()).usageForWindow(any(), any());
    }

    @Test
    void missingParamsAreStillBadRequest() throws Exception {
        expect("", status().isBadRequest());
        expect("?from=" + FROM, status().isBadRequest());
        expect("?to=" + FROM, status().isBadRequest());
        expect("?from=not-a-timestamp&to=" + FROM, status().isBadRequest());
        verify(service, never()).usageForWindow(any(), any());
    }
}
