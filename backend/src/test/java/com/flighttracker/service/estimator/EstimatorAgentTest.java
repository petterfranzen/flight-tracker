package com.flighttracker.service.estimator;

import com.flighttracker.dto.Bounds;
import com.flighttracker.model.FlightPosition;
import com.flighttracker.observability.PhaseLogger;
import com.flighttracker.repository.FlightPositionRepository;
import com.flighttracker.service.coverage.CoverageGapEstimator;
import com.flighttracker.service.coverage.GapEstimate;
import com.flighttracker.service.coverage.PollCoverageTracker;
import com.flighttracker.service.coverage.RunwayIndex;
import com.flighttracker.service.coverage.TrackState;
import com.flighttracker.service.enrichment.CallsignRouteService;
import com.flighttracker.service.enrichment.Route;
import com.flighttracker.service.live.LiveAircraft;
import com.flighttracker.service.live.LiveStateStore;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Optional;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * No DB: LiveStateStore, the position repository, the runway index and the
 * route cache are mocked; the poll tracker and the gap estimator are real
 * (both are cheap and deterministic). Verifies which estimate EstimatorAgent
 * writes for each aircraft (gap estimate, dead reckoning, clearing a stale
 * estimate, or nothing), the CAS-guard expectation on every write, and the
 * snapshot cache around the gap estimate.
 */
@ExtendWith(MockitoExtension.class)
class EstimatorAgentTest {

    private static final Instant NOW = Instant.parse("2026-10-12T12:00:00Z");
    private static final Bounds WORLDISH = new Bounds(-80, 80, -170, 170);

    @Mock
    private LiveStateStore liveStateStore;
    @Mock
    private FlightPositionRepository positionRepository;
    @Mock
    private RunwayIndex runwayIndex;
    @Mock
    private CallsignRouteService routeService;

    // routeService answers Optional.empty() unless a test stubs a route (Mockito's default for Optional)
    private final PollCoverageTracker tracker = new PollCoverageTracker();

    private static LiveAircraft airborne(String icao24, double lat, double lon, Instant observedAt) {
        return new LiveAircraft(1L, icao24, "SAS123", observedAt, lat, lon,
                10_000.0, 200.0, 90.0, 0.0, false, "opensky", null, null, null, null, null);
    }

    private static LiveAircraft onGround(String icao24, Instant observedAt) {
        return new LiveAircraft(2L, icao24, "SAS456", observedAt, 59.0, 18.0,
                0.0, 0.0, null, 0.0, true, "opensky", observedAt, null, null, null, null);
    }

    private static Route routeTo(double destLat, double destLon) {
        return new Route(null, null, null, null, "ESSA", "Arlanda", destLat, destLon);
    }

    private EstimatorAgent newAgent() {
        return newAgent(300);
    }

    /** A real PhaseLogger rather than a mock: it only writes a log line (see PhaseLoggerTest). */
    private EstimatorAgent newAgent(int maxSnapshotLoadsPerTick) {
        return new EstimatorAgent(liveStateStore, new PhaseLogger(), Clock.fixed(NOW, ZoneOffset.UTC), tracker,
                positionRepository, runwayIndex, new CoverageGapEstimator(), routeService,
                60, 10, maxSnapshotLoadsPerTick, 50);
    }

    private void givenLive(LiveAircraft... live) {
        when(liveStateStore.liveAircraft(any(), any())).thenReturn(List.of(live));
    }

    private static FlightPosition report(String icao24, Instant at, double lat, double lon) {
        return new FlightPosition(icao24, "SAS123", at, lat, lon, 10_000.0, 200.0, 90.0, 0.0, false, "opensky");
    }

    // ---- dead reckoning (aircraft not in a gap)

    @Test
    void emptyLiveSet_noWriteIssued() {
        givenLive();

        newAgent().refresh();

        verify(liveStateStore, never()).writeEstimate(any(), any(), any(), any(), any());
        verify(liveStateStore, never()).writeGapEstimate(any(), any(), any());
    }

    @Test
    void eligibleAircraft_projectsFromTheRawReportTowardsTheCallsignRouteDestination() {
        Instant observedAt = NOW.minus(Duration.ofMinutes(5));
        // The display position is already a stale estimate; only the raw report must be projected.
        LiveAircraft a = new LiveAircraft(1L, "abc123", "SAS123", observedAt, 0.0, 0.0,
                10_000.0, 200.0, 90.0, 0.0, false, "opensky", null, 5.0, 5.0, NOW.minusSeconds(30), null);
        givenLive(a);
        when(routeService.cached("SAS123")).thenReturn(Optional.of(routeTo(0.0, 90.0))); // far east, won't clip

        newAgent().refresh();

        ArgumentCaptor<Double> lat = ArgumentCaptor.forClass(Double.class);
        ArgumentCaptor<Double> lon = ArgumentCaptor.forClass(Double.class);
        verify(liveStateStore).writeEstimate(eq("abc123"), eq(observedAt), lat.capture(), lon.capture(), eq(NOW));
        assertThat(lat.getValue()).isCloseTo(0.0, org.assertj.core.data.Offset.offset(0.01));
        // 200 m/s for 300 s due east from lon 0 is about 0.54 degrees, not 5.5
        assertThat(lon.getValue()).isBetween(0.4, 0.7);
        verify(liveStateStore, never()).writeGapEstimate(any(), any(), any());
    }

    @Test
    void aircraftWithoutARoute_neverEstimated_writeSkippedEntirely() {
        givenLive(airborne("abc123", 0.0, 0.0, NOW.minus(Duration.ofHours(1))));

        newAgent().refresh();

        verify(liveStateStore, never()).writeEstimate(any(), any(), any(), any(), any());
    }

    @Test
    void ineligibleAircraftWithStaleEstimate_clearsItToNullRatherThanSkipping() {
        Instant observedAt = NOW.minus(Duration.ofHours(1));
        givenLive(onGround("def456", observedAt));
        when(liveStateStore.icao24sWithEstimate()).thenReturn(Set.of("def456"));

        newAgent().refresh();

        verify(liveStateStore).writeEstimate("def456", observedAt, null, null, null);
    }

    @Test
    void eligibleAndStaleEstimateAircraft_bothWrittenWithCorrectValues() {
        Instant observedAt = NOW.minus(Duration.ofHours(1));
        givenLive(airborne("abc123", 0.0, 0.0, observedAt), onGround("def456", observedAt));
        when(routeService.cached("SAS123")).thenReturn(Optional.of(routeTo(0.0, 90.0)));
        when(liveStateStore.icao24sWithEstimate()).thenReturn(Set.of("def456"));

        newAgent().refresh();

        verify(liveStateStore).writeEstimate(eq("abc123"), eq(observedAt), any(Double.class), any(Double.class), any(Instant.class));
        verify(liveStateStore).writeEstimate("def456", observedAt, null, null, null);
        verify(liveStateStore, times(2)).writeEstimate(any(), any(), any(), any(), any());
    }

    // ---- coverage gaps

    @Test
    void covered_butReportedWithinTheGraceAfterTheLastPoll_isNotAGap() {
        Instant observedAt = NOW.minusSeconds(300);
        givenLive(airborne("abc123", 59.0, 18.0, observedAt));
        tracker.recordPoll(observedAt.plusSeconds(30), null); // 30 s < the 60 s grace

        newAgent().refresh();

        verify(liveStateStore, never()).writeGapEstimate(any(), any(), any());
        verify(positionRepository, never()).findByIcao24AndObservedAtBetween(any(), any(), any());
    }

    @Test
    void hotPollThatDidNotCoverThePosition_isNotAGap() {
        givenLive(airborne("abc123", 59.0, 18.0, NOW.minusSeconds(300)));
        tracker.recordPoll(NOW.minusSeconds(10), new Bounds(0, 10, 0, 10));

        newAgent().refresh();

        verify(liveStateStore, never()).writeGapEstimate(any(), any(), any());
    }

    @Test
    void onGroundAircraft_isNeverInAGap() {
        givenLive(onGround("def456", NOW.minusSeconds(300)));
        tracker.recordPoll(NOW.minusSeconds(10), null);

        newAgent().refresh();

        verify(liveStateStore, never()).writeGapEstimate(any(), any(), any());
    }

    @Test
    void airborneAircraftMissedByACoveringPoll_getsAGapEstimateGuardedByObservedAt() {
        Instant observedAt = NOW.minusSeconds(300);
        LiveAircraft a = airborne("abc123", 59.0, 18.0, observedAt);
        givenLive(a);
        tracker.recordPoll(NOW.minusSeconds(20), WORLDISH);
        when(positionRepository.findByIcao24AndObservedAtBetween("abc123", observedAt.minus(Duration.ofMinutes(10)), observedAt))
                .thenReturn(List.of(
                        report("abc123", observedAt.minusSeconds(60), 59.0, 17.98),
                        report("abc123", observedAt.minusSeconds(30), 59.0, 17.99),
                        report("abc123", observedAt, 59.0, 18.0))); // the live report itself, must not be doubled

        newAgent().refresh();

        ArgumentCaptor<GapEstimate> gap = ArgumentCaptor.forClass(GapEstimate.class);
        verify(liveStateStore).writeGapEstimate(eq("abc123"), eq(observedAt), gap.capture());
        assertThat(gap.getValue().state()).isEqualTo(TrackState.COVERAGE_LOST);
        assertThat(gap.getValue().at()).isEqualTo(NOW);
        assertThat(gap.getValue().estLon()).isGreaterThan(18.0); // dead-reckoned east, along its track
        verify(runwayIndex).near(59.0, 18.0, 50_000.0);
        verify(liveStateStore, never()).writeEstimate(any(), any(), any(), any(), any());
    }

    @Test
    void gapSnapshot_isReadOncePerObservedAt_andAgainWhenTheReportChanges() {
        Instant first = NOW.minusSeconds(300);
        Instant second = NOW.minusSeconds(200);
        tracker.recordPoll(NOW.minusSeconds(5), null);
        EstimatorAgent agent = newAgent();

        givenLive(airborne("abc123", 59.0, 18.0, first));
        agent.refresh();
        agent.refresh();
        verify(positionRepository, times(1)).findByIcao24AndObservedAtBetween(any(), any(), any());

        givenLive(airborne("abc123", 59.0, 18.1, second)); // a new real report, then silent again
        agent.refresh();
        verify(positionRepository, times(2)).findByIcao24AndObservedAtBetween(any(), any(), any());
        verify(liveStateStore, times(3)).writeGapEstimate(eq("abc123"), any(), any());
    }

    @Test
    void gapSnapshot_isDroppedWhenTheAircraftLeavesTheLiveSet() {
        Instant observedAt = NOW.minusSeconds(300);
        tracker.recordPoll(NOW.minusSeconds(5), null);
        EstimatorAgent agent = newAgent();
        LiveAircraft a = airborne("abc123", 59.0, 18.0, observedAt);

        givenLive(a);
        agent.refresh();
        givenLive(airborne("other99", 10.0, 10.0, NOW.minusSeconds(5))); // abc123 evicted
        agent.refresh();
        givenLive(a);
        agent.refresh();

        verify(positionRepository, times(2)).findByIcao24AndObservedAtBetween(eq("abc123"), any(), any());
    }

    @Test
    void newSnapshotLoadsPerTick_areCapped_andTheRestWaitForTheNextTick() {
        Instant observedAt = NOW.minusSeconds(300);
        tracker.recordPoll(NOW.minusSeconds(5), null);
        givenLive(airborne("aaa111", 59.0, 18.0, observedAt),
                airborne("bbb222", 59.1, 18.0, observedAt),
                airborne("ccc333", 59.2, 18.0, observedAt));
        EstimatorAgent agent = newAgent(2);

        agent.refresh();
        verify(positionRepository, times(2)).findByIcao24AndObservedAtBetween(any(), any(), any());
        verify(liveStateStore, times(2)).writeGapEstimate(any(), any(), any());

        agent.refresh(); // the first two are cached; the third gets this tick's budget
        verify(positionRepository, times(3)).findByIcao24AndObservedAtBetween(any(), any(), any());
        verify(liveStateStore, times(5)).writeGapEstimate(any(), any(), any());
    }
}
