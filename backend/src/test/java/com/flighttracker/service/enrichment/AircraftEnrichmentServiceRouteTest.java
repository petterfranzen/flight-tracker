package com.flighttracker.service.enrichment;

import com.flighttracker.repository.AircraftRepository;
import org.junit.jupiter.api.Test;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/** AircraftEnrichmentService.routeFor: the route of the current flight, never an earlier leg's. */
class AircraftEnrichmentServiceRouteTest {

    private static final Instant NOW = Instant.parse("2026-10-01T12:00:00Z");
    private static final Route AMS_ARN = new Route("EHAM", "Schiphol", 52.3, 4.76, "ESSA", "Arlanda", 59.65, 17.92);
    private static final Route AMS_CDG = new Route("EHAM", "Schiphol", null, null, "LFPG", "Charles de Gaulle", null, null);

    private final CallsignRouteService callsignRoutes = mock(CallsignRouteService.class);
    private final OpenSkyFlightsClient flightsClient = mock(OpenSkyFlightsClient.class);
    private final AirportLookupService airportLookup = mock(AirportLookupService.class);
    private final AircraftEnrichmentService service = new AircraftEnrichmentService(
            mock(AircraftRepository.class), mock(AdsbdbClient.class), flightsClient, airportLookup, callsignRoutes,
            Clock.fixed(NOW, ZoneOffset.UTC));

    @Test
    void callsignRouteWinsAndOpenSkyIsNotAsked() {
        when(callsignRoutes.resolve("KLM1111")).thenReturn(Optional.of(AMS_ARN));

        assertThat(service.routeFor("48415e", "KLM1111", NOW.minusSeconds(3600))).contains(AMS_ARN);
        verify(flightsClient, never()).fetchRoute(any(), any());
    }

    @Test
    void fallbackIsAskedForTheCurrentLegAndCachedPerLeg() {
        when(callsignRoutes.resolve(any())).thenReturn(Optional.empty());
        when(airportLookup.lookup(any())).thenReturn(Optional.empty());
        Instant leg1 = NOW.minusSeconds(7200);
        when(flightsClient.fetchRoute("48415e", leg1)).thenReturn(Optional.of(AMS_CDG));

        assertThat(service.routeFor("48415e", "CHARTER1", leg1)).contains(AMS_CDG);
        assertThat(service.routeFor("48415e", "CHARTER1", leg1)).contains(AMS_CDG);
        verify(flightsClient, times(1)).fetchRoute("48415e", leg1);
        assertThat(service.knownRoute("48415e", "CHARTER1")).contains(AMS_CDG);

        // A new leg never reuses the previous leg's answer.
        Instant leg2 = NOW.minusSeconds(600);
        when(flightsClient.fetchRoute("48415e", leg2)).thenReturn(Optional.empty());
        assertThat(service.routeFor("48415e", "CHARTER1", leg2)).isEmpty();
        assertThat(service.knownRoute("48415e", "CHARTER1")).isEmpty();
    }

    @Test
    void noLegStartMeansNoFallbackGuess() {
        when(callsignRoutes.resolve(any())).thenReturn(Optional.empty());

        assertThat(service.routeFor("48415e", null, null)).isEmpty();
        verify(flightsClient, never()).fetchRoute(any(), any());
    }
}
