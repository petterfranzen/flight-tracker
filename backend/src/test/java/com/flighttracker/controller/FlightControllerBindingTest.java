package com.flighttracker.controller;

import com.flighttracker.dto.Bounds;
import com.flighttracker.dto.LiveOverview;
import com.flighttracker.repository.FlightPositionRepository;
import com.flighttracker.service.ViewportService;
import com.flighttracker.service.confirmation.ConfirmationStore;
import com.flighttracker.service.live.ActiveTrafficQuery;
import com.flighttracker.service.live.LiveFlightSearch;
import com.flighttracker.service.live.LiveStateStore;
import com.flighttracker.service.live.PlaneAllowance;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyDouble;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * The @QueryParams records on /live, /live/clusters and /live/overview bind
 * from the query string only, by their exact names, with @RequestParam's own
 * defaults and 400s: no header, `_`/`!`-prefixed or indexed name reaches them.
 */
class FlightControllerBindingTest {

    private static final Bounds WORLD = new Bounds(-90, 90, -180, 180);

    private final LiveStateStore liveStateStore = mock(LiveStateStore.class);
    private final ViewportService viewportService = mock(ViewportService.class);
    private final MockMvc mvc = MockMvcBuilders
            .standaloneSetup(new FlightController(liveStateStore, mock(FlightPositionRepository.class),
                    viewportService, new ConfirmationStore(120, 100), mock(LiveFlightSearch.class)))
            .setCustomArgumentResolvers(new QueryParamsResolver())
            .build();

    private static MockHttpServletRequestBuilder world(String path) {
        return get(path).param("latMin", "-90").param("latMax", "90")
                .param("lonMin", "-180").param("lonMax", "180");
    }

    @Test
    void clusters_bindsTheBboxAndDefaultsGridDeg() throws Exception {
        when(liveStateStore.clustered(any(), anyDouble())).thenReturn(List.of());

        mvc.perform(world("/api/flights/live/clusters")).andExpect(status().isOk());

        ArgumentCaptor<ActiveTrafficQuery> query = ArgumentCaptor.forClass(ActiveTrafficQuery.class);
        verify(liveStateStore).clustered(query.capture(), eq(2.0));
        assertThat(query.getValue().bounds()).isEqualTo(WORLD);
    }

    @Test
    void clusters_missingOrMalformedBboxIsABadRequest() throws Exception {
        mvc.perform(get("/api/flights/live/clusters").param("latMax", "90").param("lonMin", "-180")
                        .param("lonMax", "180").header("latMin", "-90").param("_latMin", "-90"))
                .andExpect(status().isBadRequest());
        mvc.perform(get("/api/flights/live/clusters").param("latMin", "abc").param("latMax", "90")
                        .param("lonMin", "-180").param("lonMax", "180"))
                .andExpect(status().isBadRequest());
        verifyNoInteractions(liveStateStore);
    }

    @Test
    void overview_bindsEveryParameterByName() throws Exception {
        when(liveStateStore.discovered(any(), anyDouble(), anyInt())).thenReturn(new LiveOverview(List.of(), List.of()));

        mvc.perform(world("/api/flights/live/overview").param("gridDeg", "1").param("limit", "50")
                        .param("declutter", "true"))
                .andExpect(status().isOk());

        verify(liveStateStore).discovered(any(), eq(1.0), eq(50));
    }

    @Test
    void overview_headersAndPrefixedOrIndexedNamesDoNotChangeTheDefaults() throws Exception {
        when(liveStateStore.overview(any(), any())).thenReturn(new LiveOverview(List.of(), List.of()));

        mvc.perform(world("/api/flights/live/overview")
                        .header("declutter", "true").header("limit", "5").header("gridDeg", "10")
                        .param("_declutter", "true").param("!declutter", "true")
                        .param("_limit", "5").param("!perCell", "1").param("limit[0]", "5"))
                .andExpect(status().isOk());

        verify(liveStateStore).overview(any(), eq(new PlaneAllowance(2.0, 120, 6)));
        verify(liveStateStore, never()).discovered(any(), anyDouble(), anyInt());
    }

    @Test
    void overview_malformedOptionalParameterIsABadRequest() throws Exception {
        mvc.perform(world("/api/flights/live/overview").param("limit", "many"))
                .andExpect(status().isBadRequest());
        verifyNoInteractions(liveStateStore);
    }

    @Test
    void live_withAFullBboxReportsTheViewport() throws Exception {
        mvc.perform(world("/api/flights/live")).andExpect(status().isOk());

        verify(viewportService).report(WORLD);
        verify(liveStateStore).liveMarkers(any(), any(), eq(WORLD));
    }

    @Test
    void live_aPartialBboxOrBboxHeadersMeanNoViewport() throws Exception {
        mvc.perform(get("/api/flights/live").param("latMin", "-90").param("latMax", "90").param("lonMin", "-180")
                        .header("lonMax", "180").param("_lonMax", "180").param("!lonMax", "180"))
                .andExpect(status().isOk());

        verifyNoInteractions(viewportService);
        verify(liveStateStore).liveMarkers(any(), any(), isNull());
    }
}
