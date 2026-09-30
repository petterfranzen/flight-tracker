package com.flighttracker.service.estimator;

import com.flighttracker.model.Aircraft;
import com.flighttracker.model.FlightPosition;
import com.flighttracker.observability.PhaseLogger;
import com.flighttracker.repository.AircraftRepository;
import com.flighttracker.service.live.LiveStateStore;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoMoreInteractions;
import static org.mockito.Mockito.when;

/**
 * No DB — LiveStateStore/AircraftRepository are mocked. Verifies
 * EstimatorAgent calls LiveStateStore.writeEstimate with the right values
 * for each case (the CAS-guard race fix and the skip-already-null
 * optimization — see EstimatorAgent's class javadoc for both), which is
 * where the actual eligibility/skip logic lives now that the write itself
 * is a plain in-memory map update rather than a batched JDBC statement.
 */
@ExtendWith(MockitoExtension.class)
class EstimatorAgentTest {

    @Mock
    private LiveStateStore liveStateStore;
    @Mock
    private AircraftRepository aircraftRepository;

    private static FlightPosition livePosition(String icao24, double lat, double lon, Instant observedAt) {
        return new FlightPosition(icao24, "SAS123", observedAt, lat, lon,
                10_000.0, 200.0, 90.0, 0.0, false, "opensky");
    }

    private static Aircraft withDestination(String icao24, double destLat, double destLon) {
        return new Aircraft(icao24, null, null, null, null, null, null, null,
                null, null, destLat, destLon, null, null, null, null, null);
    }

    /**
     * A real PhaseLogger rather than a mock: it only writes a log line,
     * and none of these tests are about what it writes — see
     * PhaseLoggerTest for that.
     */
    private EstimatorAgent newAgent() {
        return new EstimatorAgent(liveStateStore, aircraftRepository, new PhaseLogger());
    }

    private void givenLive(List<FlightPosition> live) {
        when(liveStateStore.liveFlightPositions(any(), any(), isNull())).thenReturn(live);
    }

    @Test
    void emptyLiveSet_noWriteIssued() {
        givenLive(List.of());

        newAgent().refresh();

        verify(liveStateStore, never()).writeEstimate(any(), any(), any(), any(), any());
        verifyNoMoreInteractions(aircraftRepository);
    }

    @Test
    void eligibleAircraft_writesProjectedValuesAndTheExactObservedAtRead() {
        Instant observedAt = Instant.now().minus(Duration.ofHours(1));
        FlightPosition p = livePosition("abc123", 0.0, 0.0, observedAt);
        givenLive(List.of(p));
        when(aircraftRepository.findAllById(List.of("abc123")))
                .thenReturn(List.of(withDestination("abc123", 0.0, 90.0))); // far east, won't clip
        when(liveStateStore.icao24sWithEstimate()).thenReturn(Set.of());

        newAgent().refresh();

        ArgumentCaptor<Double> lat = ArgumentCaptor.forClass(Double.class);
        ArgumentCaptor<Double> lon = ArgumentCaptor.forClass(Double.class);
        ArgumentCaptor<Instant> at = ArgumentCaptor.forClass(Instant.class);
        verify(liveStateStore).writeEstimate(eq("abc123"), eq(observedAt), lat.capture(), lon.capture(), at.capture());
        assertThat(lat.getValue()).isNotNull();
        assertThat(lon.getValue()).isNotNull();
        assertThat(at.getValue()).isNotNull();
    }

    @Test
    void ineligibleAircraftNeverEstimated_writeSkippedEntirely() {
        // The common steady-state case: grounded (or no destination/too
        // slow/too recent), and there's no stored estimate to clear either
        // - this is the case the skip-optimization exists for (see
        // EstimatorAgent's javadoc).
        Instant observedAt = Instant.now().minus(Duration.ofHours(1));
        FlightPosition onGround = new FlightPosition("def456", "SAS456", observedAt, 59.0, 18.0,
                0.0, 0.0, null, 0.0, true, "opensky"); // on_ground = true
        givenLive(List.of(onGround));
        when(aircraftRepository.findAllById(List.of("def456")))
                .thenReturn(List.of(withDestination("def456", 0.0, 90.0)));
        when(liveStateStore.icao24sWithEstimate()).thenReturn(Set.of()); // not previously estimated

        newAgent().refresh();

        verify(liveStateStore, never()).writeEstimate(any(), any(), any(), any(), any());
    }

    @Test
    void ineligibleAircraftWithStaleEstimate_clearsItToNullRatherThanSkipping() {
        // Was projecting last cycle (destination got cleared, or it just
        // landed) - this aircraft currently has a stored estimate, so this
        // write is real: clearing a stale estimate, not a no-op.
        Instant observedAt = Instant.now().minus(Duration.ofHours(1));
        FlightPosition onGround = new FlightPosition("def456", "SAS456", observedAt, 59.0, 18.0,
                0.0, 0.0, null, 0.0, true, "opensky"); // on_ground = true
        givenLive(List.of(onGround));
        when(aircraftRepository.findAllById(List.of("def456")))
                .thenReturn(List.of(withDestination("def456", 0.0, 90.0)));
        when(liveStateStore.icao24sWithEstimate()).thenReturn(Set.of("def456")); // has a stale estimate

        newAgent().refresh();

        verify(liveStateStore).writeEstimate("def456", observedAt, null, null, null);
    }

    @Test
    void mixedEligibleAndIneligibleWithStaleEstimate_bothWrittenWithCorrectValues() {
        Instant observedAt = Instant.now().minus(Duration.ofHours(1));
        FlightPosition eligible = livePosition("abc123", 0.0, 0.0, observedAt);
        FlightPosition onGround = new FlightPosition("def456", "SAS456", observedAt, 59.0, 18.0,
                0.0, 0.0, null, 0.0, true, "opensky");
        givenLive(List.of(eligible, onGround));
        when(aircraftRepository.findAllById(List.of("abc123", "def456")))
                .thenReturn(List.of(withDestination("abc123", 0.0, 90.0), withDestination("def456", 0.0, 90.0)));
        // def456 has a stale estimate to clear; abc123's presence never
        // depends on this set (a genuine projection always writes).
        when(liveStateStore.icao24sWithEstimate()).thenReturn(Set.of("def456"));

        newAgent().refresh();

        verify(liveStateStore).writeEstimate(eq("abc123"), eq(observedAt), any(Double.class), any(Double.class), any(Instant.class));
        verify(liveStateStore).writeEstimate("def456", observedAt, null, null, null);
        verify(liveStateStore, times(2)).writeEstimate(any(), any(), any(), any(), any());
    }

    @Test
    void aircraftWithNoMatchingDestinationRowAndStaleEstimate_treatedAsIneligibleNotAnException() {
        Instant observedAt = Instant.now().minus(Duration.ofHours(1));
        FlightPosition p = livePosition("zzz999", 0.0, 0.0, observedAt);
        givenLive(List.of(p));
        when(aircraftRepository.findAllById(List.of("zzz999"))).thenReturn(List.of()); // no Aircraft row at all
        when(liveStateStore.icao24sWithEstimate()).thenReturn(Set.of("zzz999")); // exercise the clear-write path

        newAgent().refresh(); // must not throw

        verify(liveStateStore).writeEstimate("zzz999", observedAt, null, null, null);
    }
}
