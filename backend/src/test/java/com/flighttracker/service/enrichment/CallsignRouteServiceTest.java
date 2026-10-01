package com.flighttracker.service.enrichment;

import com.flighttracker.repository.CallsignRouteRepository;
import com.flighttracker.service.ViewportService;
import com.flighttracker.service.live.LiveAircraft;
import com.flighttracker.service.live.LiveStateStore;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class CallsignRouteServiceTest {

    private static final Route ARN_KLR = new Route("ESSA", "Stockholm Arlanda", 59.65, 17.92, "ESMQ", "Kalmar Airport", 56.69, 16.29);

    /** A clock the test moves by hand. */
    private static final class TestClock extends Clock {
        Instant now = Instant.parse("2026-10-01T12:00:00Z");

        @Override public ZoneId getZone() { return ZoneOffset.UTC; }
        @Override public Clock withZone(ZoneId zone) { return this; }
        @Override public Instant instant() { return now; }
        void advance(Duration d) { now = now.plus(d); }
    }

    private final AdsbdbClient adsbdb = mock(AdsbdbClient.class);
    private final CallsignRouteRepository repository = mock(CallsignRouteRepository.class);
    private final LiveStateStore liveStateStore = mock(LiveStateStore.class);
    private final TestClock clock = new TestClock();
    private CallsignRouteService service;

    @BeforeEach
    void setUp() {
        when(repository.findAll()).thenReturn(List.of());
        service = new CallsignRouteService(adsbdb, repository, liveStateStore, new ViewportService(), clock);
        service.load();
    }

    private static AdsbdbClient.RouteLookup found(Route r) {
        return new AdsbdbClient.RouteLookup(AdsbdbClient.LookupStatus.FOUND, Optional.of(r));
    }

    private static AdsbdbClient.RouteLookup status(AdsbdbClient.LookupStatus s) {
        return new AdsbdbClient.RouteLookup(s, Optional.empty());
    }

    private static LiveAircraft live(String icao24, String callsign, double lat, double lon) {
        return new LiveAircraft(1L, icao24, callsign, Instant.now(), lat, lon,
                null, null, null, null, false, "opensky", null, null, null, null);
    }

    @Test
    void resolveLooksUpOnceThenServesFromCache_normalisingTheCallsign() {
        when(adsbdb.lookupRoute("BRX101")).thenReturn(found(ARN_KLR));

        assertThat(service.resolve(" brx101  ")).contains(ARN_KLR);
        assertThat(service.resolve("BRX101")).contains(ARN_KLR);
        assertThat(service.cached("Brx101")).contains(ARN_KLR);

        verify(adsbdb, times(1)).lookupRoute("BRX101");
        verify(repository).upsert(eq("BRX101"), eq(ARN_KLR), any());
    }

    @Test
    void aMissIsCachedButRetriedAfterItsTtl() {
        when(adsbdb.lookupRoute("N123AB")).thenReturn(status(AdsbdbClient.LookupStatus.NOT_FOUND));

        assertThat(service.resolve("N123AB")).isEmpty();
        assertThat(service.resolve("N123AB")).isEmpty();
        verify(adsbdb, times(1)).lookupRoute("N123AB");
        verify(repository).upsert(eq("N123AB"), isNull(), any());

        clock.advance(CallsignRouteService.MISS_TTL.plusMinutes(1));
        service.resolve("N123AB");
        verify(adsbdb, times(2)).lookupRoute("N123AB");
    }

    @Test
    void throttlingPausesLookupsAndIsNotRecordedAsAMiss() {
        when(liveStateStore.liveAircraft(any(), any())).thenReturn(List.of(live("a", "SAS1", 0, 0), live("b", "SAS2", 0, 0)));
        when(adsbdb.lookupRoute(anyString())).thenReturn(status(AdsbdbClient.LookupStatus.THROTTLED));

        service.resolveNext(); // refills and tries the first callsign: 429
        service.resolveNext(); // paused — no call
        verify(adsbdb, times(1)).lookupRoute(anyString());
        verify(repository, never()).upsert(any(), any(), any());

        // Synchronous lookups respect the pause too.
        assertThat(service.resolve("SAS9")).isEmpty();
        verify(adsbdb, times(1)).lookupRoute(anyString());

        clock.advance(CallsignRouteService.MIN_THROTTLE_PAUSE.plusSeconds(1));
        when(adsbdb.lookupRoute(anyString())).thenReturn(found(ARN_KLR));
        service.resolveNext();
        service.resolveNext();
        assertThat(service.cached("SAS1")).contains(ARN_KLR); // the throttled one was re-queued
        assertThat(service.cached("SAS2")).contains(ARN_KLR);
    }

    @Test
    void backgroundWalkDoesOnScreenCallsignsFirstAndSkipsCachedOnes() {
        // ViewportService's default viewport is the Baltic (54-66N, 10-25E).
        when(liveStateStore.liveAircraft(any(), any())).thenReturn(List.of(
                live("a", "UAL1", 40, -74),
                live("b", "SAS2", 59, 18),
                live("c", "X", 59, 18))); // too short to be a flight number
        when(adsbdb.lookupRoute(anyString())).thenReturn(found(ARN_KLR));

        service.resolveNext();
        verify(adsbdb).lookupRoute("SAS2");
        service.resolveNext();
        verify(adsbdb).lookupRoute("UAL1");

        // Queue drained; a refill within REFILL_INTERVAL does nothing, and a
        // later one finds everything already cached.
        service.resolveNext();
        clock.advance(CallsignRouteService.REFILL_INTERVAL.plusSeconds(1));
        service.resolveNext();
        verify(adsbdb, times(2)).lookupRoute(anyString());
    }
}
