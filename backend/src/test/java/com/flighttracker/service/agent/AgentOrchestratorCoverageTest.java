package com.flighttracker.service.agent;

import com.flighttracker.dto.Bounds;
import com.flighttracker.observability.PhaseLogger;
import com.flighttracker.service.PollWindowService;
import com.flighttracker.service.ViewportService;
import com.flighttracker.service.coverage.PollCoverageTracker;
import com.flighttracker.service.enrichment.AircraftEnrichmentService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.when;

/**
 * Which polls AgentOrchestrator reports to the PollCoverageTracker: only
 * those that returned something (an empty list may be a failed poll), hot
 * polls with the viewport they were made for, global sweeps for the world.
 */
@ExtendWith(MockitoExtension.class)
class AgentOrchestratorCoverageTest {

    private static final Instant NOW = Instant.parse("2026-10-12T12:00:00Z");
    private static final Bounds VIEW = new Bounds(55, 69, 10, 25);

    @Mock
    private FlightDataAgent agent;
    @Mock
    private PositionPersistenceService persistenceService;
    @Mock
    private AircraftEnrichmentService enrichmentService;
    @Mock
    private PollWindowService pollWindowService;
    @Mock
    private ViewportService viewportService;

    private final PollCoverageTracker tracker = new PollCoverageTracker();

    private static RawPositionReport report() {
        return new RawPositionReport("abc123", "SAS1", NOW, 59.0, 18.0, 10_000.0, 200.0, 90.0, 0.0, false);
    }

    /** A clock the test can move, to see which instant gets recorded. */
    private final AtomicReference<Instant> clockNow = new AtomicReference<>(NOW);
    private final Clock clock = new Clock() {
        @Override
        public ZoneOffset getZone() {
            return ZoneOffset.UTC;
        }

        @Override
        public Clock withZone(java.time.ZoneId zone) {
            return this;
        }

        @Override
        public Instant instant() {
            return clockNow.get();
        }
    };

    private AgentOrchestrator orchestrator() {
        return new AgentOrchestrator(List.of(agent), persistenceService, enrichmentService, pollWindowService,
                new PhaseLogger(), new SweepHealthTracker(), viewportService, tracker, clock);
    }

    @BeforeEach
    void hotPollingAllowed() {
        org.mockito.Mockito.lenient().when(pollWindowService.isActive()).thenReturn(true);
        org.mockito.Mockito.lenient().when(pollWindowService.hotPollBudgetAvailable()).thenReturn(true);
        org.mockito.Mockito.lenient().when(viewportService.current()).thenReturn(VIEW);
        org.mockito.Mockito.lenient().when(agent.sourceName()).thenReturn("opensky");
        org.mockito.Mockito.lenient().when(persistenceService.persist(any(), any())).thenReturn(List.of());
    }

    @Test
    void hotPollWithReports_isRecordedForTheViewport() {
        when(agent.poll()).thenReturn(List.of(report()));

        orchestrator().pollAll();

        assertThat(tracker.lastCoveringPollAt(59, 18)).contains(NOW);
        assertThat(tracker.lastCoveringPollAt(-30, 150)).isEmpty(); // a hot poll is not the world
    }

    @Test
    void hotPollThatReturnedNothing_isNotRecorded() {
        when(agent.poll()).thenReturn(List.of());

        orchestrator().pollAll();

        assertThat(tracker.lastCoveringPollAt(59, 18)).isEmpty();
    }

    @Test
    void globalSweepWithReports_coversTheWorld_andAnEmptyOneDoesNot() {
        when(agent.pollGlobal()).thenReturn(List.of());
        orchestrator().pollGlobalSweep();
        assertThat(tracker.lastCoveringPollAt(-30, 150)).isEmpty();

        when(agent.pollGlobal()).thenReturn(List.of(report()));
        orchestrator().pollGlobalSweep();
        assertThat(tracker.lastCoveringPollAt(-30, 150)).contains(NOW);
    }

    @Test
    void hotPollIsRecordedAfterPersisting_withTheTimeThePollReturned() {
        when(agent.poll()).thenReturn(List.of(report()));
        when(persistenceService.persist(any(), any())).thenAnswer(inv -> {
            // while the reports are being written, nothing yet says this area was polled
            assertThat(tracker.lastCoveringPollAt(59, 18)).isEmpty();
            clockNow.set(NOW.plusSeconds(20)); // persisting takes a while
            return List.of();
        });

        orchestrator().pollAll();

        assertThat(tracker.lastCoveringPollAt(59, 18)).contains(NOW);
    }

    @Test
    void globalSweepIsRecordedAfterPersistingTheBatch() {
        when(agent.pollGlobal()).thenReturn(List.of(report()));
        org.mockito.Mockito.doAnswer(inv -> {
            assertThat(tracker.lastCoveringPollAt(-30, 150)).isEmpty();
            clockNow.set(NOW.plusSeconds(90));
            return null;
        }).when(persistenceService).persistBatch(any(), any());

        orchestrator().pollGlobalSweep();

        assertThat(tracker.lastCoveringPollAt(-30, 150)).contains(NOW);
    }
}
