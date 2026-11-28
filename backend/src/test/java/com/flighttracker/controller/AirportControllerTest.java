package com.flighttracker.controller;

import com.flighttracker.repository.AirportRepository;
import org.junit.jupiter.api.Test;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import java.util.Optional;

import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/** /api/airports/info: an unknown code is a bodyless 404, an over-long one a 400 that is never looked up. */
class AirportControllerTest {

    private final AirportRepository airports = mock(AirportRepository.class);
    private final MockMvc mvc = MockMvcBuilders.standaloneSetup(new AirportController(airports)).build();

    @Test
    void anUnknownCodeIsANotFound() throws Exception {
        when(airports.findByIataCode("XYZ")).thenReturn(Optional.empty());

        mvc.perform(get("/api/airports/info").param("code", "XYZ")).andExpect(status().isNotFound());
    }

    @Test
    void aCodeOverTheCapIsABadRequestAndNeverLookedUp() throws Exception {
        String tooLong = "A".repeat(AirportController.MAX_CODE_LENGTH + 1);

        mvc.perform(get("/api/airports/info").param("code", tooLong)).andExpect(status().isBadRequest());

        verify(airports, never()).findByIataCode(anyString());
    }
}
