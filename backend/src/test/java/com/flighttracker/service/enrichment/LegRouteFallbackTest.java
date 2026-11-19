package com.flighttracker.service.enrichment;

import com.flighttracker.model.Airport;
import org.junit.jupiter.api.Test;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/** LegRouteFallback: OpenSky's route for the current leg, cached per leg, names backfilled locally. */
class LegRouteFallbackTest {

    private static final Instant NOW = Instant.parse("2026-10-01T12:00:00Z");
    private static final Instant LEG = NOW.minusSeconds(3600);

    private final OpenSkyFlightsClient flightsClient = mock(OpenSkyFlightsClient.class);
    private final AirportLookupService airportLookup = mock(AirportLookupService.class);
    private final MutableClock clock = new MutableClock(NOW);
    private final LegRouteFallback fallback = new LegRouteFallback(flightsClient, airportLookup, clock);

    @Test
    void knowsNothingBeforeTheFirstLookup() {
        assertThat(fallback.known("48415e")).isEmpty();
    }

    @Test
    void aMissIsRetriedOnlyAfterTheRetryInterval() {
        when(flightsClient.fetchRoute("48415e", LEG)).thenReturn(Optional.empty());

        assertThat(fallback.routeFor("48415e", LEG)).isEmpty();
        clock.advance(LegRouteFallback.RETRY_AFTER_MISS.minusSeconds(1));
        assertThat(fallback.routeFor("48415e", LEG)).isEmpty();
        verify(flightsClient, times(1)).fetchRoute("48415e", LEG);

        clock.advance(Duration.ofSeconds(1));
        assertThat(fallback.routeFor("48415e", LEG)).isEmpty();
        verify(flightsClient, times(2)).fetchRoute("48415e", LEG);
    }

    @Test
    void aFoundRouteIsKeptForTheWholeLeg() {
        Route route = new Route("EHAM", "Schiphol", 52.3, 4.76, "ESSA", "Arlanda", 59.65, 17.92);
        when(flightsClient.fetchRoute("48415e", LEG)).thenReturn(Optional.of(route));

        assertThat(fallback.routeFor("48415e", LEG)).contains(route);
        clock.advance(LegRouteFallback.RETRY_AFTER_MISS.multipliedBy(2));
        assertThat(fallback.routeFor("48415e", LEG)).contains(route);
        assertThat(fallback.known("48415e")).contains(route);
        verify(flightsClient, times(1)).fetchRoute("48415e", LEG);
        verify(airportLookup, never()).lookup(any());
    }

    @Test
    void backfillsMissingNamesAndCoordinatesFromTheLocalTable() {
        when(flightsClient.fetchRoute("48415e", LEG))
                .thenReturn(Optional.of(new Route("EHAM", null, null, null, "LFPG", "Paris CDG", null, null)));
        when(airportLookup.lookup("EHAM")).thenReturn(Optional.of(airport("EHAM", "Schiphol", 52.3, 4.76)));

        assertThat(fallback.routeFor("48415e", LEG))
                .contains(new Route("EHAM", "Schiphol", 52.3, 4.76, "LFPG", "Paris CDG", null, null));
        verify(airportLookup, never()).lookup("LFPG");
    }

    @Test
    void leavesTheRouteAsIsWhenNothingIsFound() {
        Route bare = new Route("ZZZZ", null, null, null, "YYYY", null, null, null);
        when(flightsClient.fetchRoute("48415e", LEG)).thenReturn(Optional.of(bare));
        when(airportLookup.lookup(any())).thenReturn(Optional.empty());

        assertThat(fallback.routeFor("48415e", LEG)).containsSame(bare);
    }

    private static Airport airport(String icao, String name, double lat, double lon) {
        return new Airport(icao, null, name, null, null, lat, lon);
    }

    private static final class MutableClock extends Clock {
        private Instant now;

        MutableClock(Instant now) {
            this.now = now;
        }

        void advance(Duration d) {
            now = now.plus(d);
        }

        @Override public ZoneId getZone() { return ZoneOffset.UTC; }
        @Override public Clock withZone(ZoneId zone) { return this; }
        @Override public Instant instant() { return now; }
    }
}
