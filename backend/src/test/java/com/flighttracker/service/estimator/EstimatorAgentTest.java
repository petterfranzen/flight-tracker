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
 * CAS-guard race fix in particular — see EstimatorAgent's class javadoc).
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
    private ArgumentCaptor<ParameterizedPreparedStatementSetter<FlightPosition>> captureSetter() {
        ArgumentCaptor<ParameterizedPreparedStatementSetter<FlightPosition>> captor =
                ArgumentCaptor.forClass(ParameterizedPreparedStatementSetter.class);
        verify(jdbcTemplate).batchUpdate(anyString(), anyList(), anyInt(), captor.capture());
        return captor;
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

        new EstimatorAgent(positionRepository, aircraftRepository, jdbcTemplate).refresh();

        var setter = captureSetter().getValue();
        PreparedStatement ps = mock(PreparedStatement.class);
        setter.setValues(ps, p);

        verify(ps).setDouble(eq(1), any(Double.class)); // projected latitude, non-null
        verify(ps).setDouble(eq(2), any(Double.class)); // projected longitude, non-null
        verify(ps, never()).setNull(eq(3), any(Integer.class));
        verify(ps).setString(4, "abc123");
        verify(ps).setTimestamp(5, Timestamp.from(observedAt));
    }

    @Test
    void ineligibleAircraft_bindsExplicitNullTripleRatherThanSkipping() throws SQLException {
        Instant observedAt = Instant.now().minus(Duration.ofHours(1));
        FlightPosition onGround = new FlightPosition("def456", "SAS456", observedAt, 59.0, 18.0,
                0.0, 0.0, null, 0.0, true, "opensky"); // on_ground = true
        when(positionRepository.findLive(any(), any())).thenReturn(List.of(onGround));
        when(aircraftRepository.findAllById(List.of("def456")))
                .thenReturn(List.of(withDestination("def456", 0.0, 90.0)));

        new EstimatorAgent(positionRepository, aircraftRepository, jdbcTemplate).refresh();

        var setter = captureSetter().getValue();
        PreparedStatement ps = mock(PreparedStatement.class);
        setter.setValues(ps, onGround);

        verify(ps).setNull(1, Types.DOUBLE);
        verify(ps).setNull(2, Types.DOUBLE);
        verify(ps).setNull(3, Types.TIMESTAMP);
        verify(ps).setString(4, "def456");
        verify(ps).setTimestamp(5, Timestamp.from(observedAt));
    }

    @Test
    void mixedEligibleAndIneligible_bothPresentInTheSameBatchWithCorrectValues() throws SQLException {
        Instant observedAt = Instant.now().minus(Duration.ofHours(1));
        FlightPosition eligible = livePosition("abc123", 0.0, 0.0, observedAt);
        FlightPosition onGround = new FlightPosition("def456", "SAS456", observedAt, 59.0, 18.0,
                0.0, 0.0, null, 0.0, true, "opensky");
        when(positionRepository.findLive(any(), any())).thenReturn(List.of(eligible, onGround));
        when(aircraftRepository.findAllById(List.of("abc123", "def456")))
                .thenReturn(List.of(withDestination("abc123", 0.0, 90.0), withDestination("def456", 0.0, 90.0)));

        ArgumentCaptor<List<FlightPosition>> batchArgsCaptor = ArgumentCaptor.forClass(List.class);
        new EstimatorAgent(positionRepository, aircraftRepository, jdbcTemplate).refresh();

        verify(jdbcTemplate).batchUpdate(anyString(), batchArgsCaptor.capture(), anyInt(), any(ParameterizedPreparedStatementSetter.class));
        org.assertj.core.api.Assertions.assertThat(batchArgsCaptor.getValue()).containsExactlyInAnyOrder(eligible, onGround);

        var setter = captureSetter().getValue();
        PreparedStatement eligiblePs = mock(PreparedStatement.class);
        setter.setValues(eligiblePs, eligible);
        verify(eligiblePs).setDouble(eq(1), any(Double.class));

        PreparedStatement groundedPs = mock(PreparedStatement.class);
        setter.setValues(groundedPs, onGround);
        verify(groundedPs).setNull(1, Types.DOUBLE);
    }

    @Test
    void aircraftWithNoMatchingDestinationRow_treatedAsIneligibleNotAnException() throws SQLException {
        Instant observedAt = Instant.now().minus(Duration.ofHours(1));
        FlightPosition p = livePosition("zzz999", 0.0, 0.0, observedAt);
        when(positionRepository.findLive(any(), any())).thenReturn(List.of(p));
        when(aircraftRepository.findAllById(List.of("zzz999"))).thenReturn(List.of()); // no Aircraft row at all

        new EstimatorAgent(positionRepository, aircraftRepository, jdbcTemplate).refresh();

        var setter = captureSetter().getValue();
        PreparedStatement ps = mock(PreparedStatement.class);
        setter.setValues(ps, p); // must not throw

        verify(ps).setNull(1, Types.DOUBLE);
        verify(ps).setNull(2, Types.DOUBLE);
        verify(ps).setNull(3, Types.TIMESTAMP);
    }
}
