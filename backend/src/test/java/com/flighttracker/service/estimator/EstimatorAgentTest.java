package com.flighttracker.service.estimator;

import com.flighttracker.model.Aircraft;
import com.flighttracker.model.FlightPosition;
import com.flighttracker.repository.AircraftRepository;
import com.flighttracker.repository.FlightPositionRepository;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.ParameterizedPreparedStatementSetter;

import java.sql.PreparedStatement;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.sql.Types;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Set;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyList;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoMoreInteractions;
import static org.mockito.Mockito.when;

/**
 * No DB — FlightPositionRepository/AircraftRepository/JdbcTemplate are all
 * mocked. Verifies the batched UPDATE's PreparedStatementSetter binds the
 * right values, since that's where the actual write-path logic lives (the
 * CAS-guard race fix, and the skip-already-NULL optimization — see
 * EstimatorAgent's class javadoc for both).
 *
 * batchUpdate's third argument is a private PendingEstimate record internal
 * to EstimatorAgent - tests can't construct one directly, so every test
 * captures the actual List<?> passed to batchUpdate and feeds its real
 * elements back through the captured setter, rather than building its own.
 */
@ExtendWith(MockitoExtension.class)
class EstimatorAgentTest {

    @Mock
    private FlightPositionRepository positionRepository;
    @Mock
    private AircraftRepository aircraftRepository;
    @Mock
    private JdbcTemplate jdbcTemplate;

    private static FlightPosition livePosition(String icao24, double lat, double lon, Instant observedAt) {
        return new FlightPosition(icao24, "SAS123", observedAt, lat, lon,
                10_000.0, 200.0, 90.0, 0.0, false, "opensky");
    }

    private static Aircraft withDestination(String icao24, double destLat, double destLon) {
        Aircraft a = new Aircraft(icao24);
        a.setDestinationAirportLat(destLat);
        a.setDestinationAirportLon(destLon);
        return a;
    }

    @SuppressWarnings("unchecked")
    private ArgumentCaptor<List<Object>> captureBatch() {
        ArgumentCaptor<List<Object>> captor = ArgumentCaptor.forClass(List.class);
        verify(jdbcTemplate).batchUpdate(anyString(), captor.capture(), anyInt(), any(ParameterizedPreparedStatementSetter.class));
        return captor;
    }

    @SuppressWarnings("unchecked")
    private ParameterizedPreparedStatementSetter<Object> captureSetter() {
        ArgumentCaptor<ParameterizedPreparedStatementSetter<Object>> captor = ArgumentCaptor.forClass(ParameterizedPreparedStatementSetter.class);
        verify(jdbcTemplate).batchUpdate(anyString(), anyList(), anyInt(), captor.capture());
        return captor.getValue();
    }

    @Test
    void emptyLiveSet_noBatchUpdateIssued() {
        when(positionRepository.findLive(any(), any())).thenReturn(List.of());

        new EstimatorAgent(positionRepository, aircraftRepository, jdbcTemplate).refresh();

        verify(jdbcTemplate, never()).batchUpdate(anyString(), anyList(), anyInt(), any(ParameterizedPreparedStatementSetter.class));
        verifyNoMoreInteractions(aircraftRepository);
    }

    @Test
    void eligibleAircraft_bindsProjectedValuesAndTheExactObservedAtRead() throws SQLException {
        Instant observedAt = Instant.now().minus(Duration.ofHours(1));
        FlightPosition p = livePosition("abc123", 0.0, 0.0, observedAt);
        when(positionRepository.findLive(any(), any())).thenReturn(List.of(p));
        when(aircraftRepository.findAllById(List.of("abc123")))
                .thenReturn(List.of(withDestination("abc123", 0.0, 90.0))); // far east, won't clip
        when(positionRepository.findIcao24sWithEstimate()).thenReturn(Set.of());

        new EstimatorAgent(positionRepository, aircraftRepository, jdbcTemplate).refresh();

        List<Object> batch = captureBatch().getValue();
        org.assertj.core.api.Assertions.assertThat(batch).hasSize(1);
        var setter = captureSetter();
        PreparedStatement ps = mock(PreparedStatement.class);
        setter.setValues(ps, batch.get(0));

        verify(ps).setDouble(eq(1), any(Double.class)); // projected latitude, non-null
        verify(ps).setDouble(eq(2), any(Double.class)); // projected longitude, non-null
        verify(ps, never()).setNull(eq(3), any(Integer.class));
        verify(ps).setString(4, "abc123");
        verify(ps).setTimestamp(5, Timestamp.from(observedAt));
    }

    @Test
    void ineligibleAircraftNeverEstimated_writeSkippedEntirely() {
        // The common steady-state case: grounded (or no destination/too
        // slow/too recent), and estimated_latitude is already NULL, so
        // there is genuinely nothing to write - this is the case the
        // skip-optimization exists for (see EstimatorAgent's javadoc).
        Instant observedAt = Instant.now().minus(Duration.ofHours(1));
        FlightPosition onGround = new FlightPosition("def456", "SAS456", observedAt, 59.0, 18.0,
                0.0, 0.0, null, 0.0, true, "opensky"); // on_ground = true
        when(positionRepository.findLive(any(), any())).thenReturn(List.of(onGround));
        when(aircraftRepository.findAllById(List.of("def456")))
                .thenReturn(List.of(withDestination("def456", 0.0, 90.0)));
        when(positionRepository.findIcao24sWithEstimate()).thenReturn(Set.of()); // not previously estimated

        new EstimatorAgent(positionRepository, aircraftRepository, jdbcTemplate).refresh();

        verify(jdbcTemplate, never()).batchUpdate(anyString(), anyList(), anyInt(), any(ParameterizedPreparedStatementSetter.class));
    }

    @Test
    void ineligibleAircraftWithStaleEstimate_clearsItToNullRatherThanSkipping() throws SQLException {
        // Was projecting last cycle (destination got cleared, or it just
        // landed) - estimated_latitude is currently non-NULL, so this
        // write is real: clearing a stale estimate, not a no-op.
        Instant observedAt = Instant.now().minus(Duration.ofHours(1));
        FlightPosition onGround = new FlightPosition("def456", "SAS456", observedAt, 59.0, 18.0,
                0.0, 0.0, null, 0.0, true, "opensky"); // on_ground = true
        when(positionRepository.findLive(any(), any())).thenReturn(List.of(onGround));
        when(aircraftRepository.findAllById(List.of("def456")))
                .thenReturn(List.of(withDestination("def456", 0.0, 90.0)));
        when(positionRepository.findIcao24sWithEstimate()).thenReturn(Set.of("def456")); // has a stale estimate

        new EstimatorAgent(positionRepository, aircraftRepository, jdbcTemplate).refresh();

        List<Object> batch = captureBatch().getValue();
        org.assertj.core.api.Assertions.assertThat(batch).hasSize(1);
        var setter = captureSetter();
        PreparedStatement ps = mock(PreparedStatement.class);
        setter.setValues(ps, batch.get(0));

        verify(ps).setNull(1, Types.DOUBLE);
        verify(ps).setNull(2, Types.DOUBLE);
        verify(ps).setNull(3, Types.TIMESTAMP);
        verify(ps).setString(4, "def456");
        verify(ps).setTimestamp(5, Timestamp.from(observedAt));
    }

    @Test
    void mixedEligibleAndIneligibleWithStaleEstimate_bothPresentInTheSameBatchWithCorrectValues() throws SQLException {
        Instant observedAt = Instant.now().minus(Duration.ofHours(1));
        FlightPosition eligible = livePosition("abc123", 0.0, 0.0, observedAt);
        FlightPosition onGround = new FlightPosition("def456", "SAS456", observedAt, 59.0, 18.0,
                0.0, 0.0, null, 0.0, true, "opensky");
        when(positionRepository.findLive(any(), any())).thenReturn(List.of(eligible, onGround));
        when(aircraftRepository.findAllById(List.of("abc123", "def456")))
                .thenReturn(List.of(withDestination("abc123", 0.0, 90.0), withDestination("def456", 0.0, 90.0)));
        // def456 has a stale estimate to clear; abc123's presence never
        // depends on this set (a genuine projection always writes).
        when(positionRepository.findIcao24sWithEstimate()).thenReturn(Set.of("def456"));

        new EstimatorAgent(positionRepository, aircraftRepository, jdbcTemplate).refresh();

        List<Object> batch = captureBatch().getValue();
        org.assertj.core.api.Assertions.assertThat(batch).hasSize(2);
        var setter = captureSetter();

        // Order within the batch isn't guaranteed - bind each row against
        // its own mock and check that exactly one got projected values
        // and the other got nulled, without caring which is which.
        int projectedCount = 0, nulledCount = 0;
        for (Object item : batch) {
            PreparedStatement ps = mock(PreparedStatement.class);
            setter.setValues(ps, item);
            try {
                verify(ps).setDouble(eq(1), any(Double.class));
                projectedCount++;
            } catch (AssertionError notProjected) {
                verify(ps).setNull(1, Types.DOUBLE);
                nulledCount++;
            }
        }
        org.assertj.core.api.Assertions.assertThat(projectedCount).isEqualTo(1);
        org.assertj.core.api.Assertions.assertThat(nulledCount).isEqualTo(1);
    }

    @Test
    void aircraftWithNoMatchingDestinationRowAndStaleEstimate_treatedAsIneligibleNotAnException() throws SQLException {
        Instant observedAt = Instant.now().minus(Duration.ofHours(1));
        FlightPosition p = livePosition("zzz999", 0.0, 0.0, observedAt);
        when(positionRepository.findLive(any(), any())).thenReturn(List.of(p));
        when(aircraftRepository.findAllById(List.of("zzz999"))).thenReturn(List.of()); // no Aircraft row at all
        when(positionRepository.findIcao24sWithEstimate()).thenReturn(Set.of("zzz999")); // exercise the clear-write path

        new EstimatorAgent(positionRepository, aircraftRepository, jdbcTemplate).refresh();

        List<Object> batch = captureBatch().getValue();
        var setter = captureSetter();
        PreparedStatement ps = mock(PreparedStatement.class);
        setter.setValues(ps, batch.get(0)); // must not throw

        verify(ps).setNull(1, Types.DOUBLE);
        verify(ps).setNull(2, Types.DOUBLE);
        verify(ps).setNull(3, Types.TIMESTAMP);
    }
}
