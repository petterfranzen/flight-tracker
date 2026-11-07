package com.flighttracker.service.agent;

import com.flighttracker.observability.PhaseLogger;
import com.flighttracker.service.PollWindowService;
import com.flighttracker.service.ViewportService;
import com.flighttracker.service.coverage.PollCoverageTracker;
import com.flighttracker.service.enrichment.AircraftEnrichmentService;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.lenient;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * lastSweepAt tells the truth about freshness: it advances only when the
 * sweep actually wrote rows, so a cycle where every source backed off or came
 * back empty cannot look fresh.
 */
@ExtendWith(MockitoExtension.class)
class AgentOrchestratorSweepHealthTest {

    private static final Instant NOW = Instant.parse("2026-10-12T12:00:00Z");

    @Mock
    private PositionPersistenceService persistenceService;
    @Mock
    private AircraftEnrichmentService enrichmentService;
    @Mock
    private PollWindowService pollWindowService;
    @Mock
    private ViewportService viewportService;

    private final SweepHealthTracker sweepHealth = new SweepHealthTracker();

    private static RawPositionReport report() {
        return new RawPositionReport("abc123", "SAS1", NOW, 59.0, 18.0, 10_000.0, 200.0, 90.0, 0.0, false);
    }

    private AgentOrchestrator orchestrator(List<FlightDataAgent> agents) {
        return new AgentOrchestrator(agents, persistenceService, enrichmentService, pollWindowService,
                new PhaseLogger(), sweepHealth, viewportService, new PollCoverageTracker(),
                Clock.fixed(NOW, ZoneOffset.UTC));
    }

    @Test
    void aSweepWhereEverySourceCameBackEmpty_doesNotAdvanceLastSweepAt() {
        FlightDataAgent quiet = mock(FlightDataAgent.class);
        lenient().when(quiet.sourceName()).thenReturn("opensky");
        when(quiet.pollGlobal()).thenReturn(List.of());

        orchestrator(List.of(quiet)).pollGlobalSweep();

        assertThat(sweepHealth.lastSweepAt()).isEmpty();
        assertThat(sweepHealth.consecutiveSkips()).isEqualTo(1);
    }

    @Test
    void aQuietSweepThenAProductiveOne_advancesTheStamp_andResetsTheSkips() {
        FlightDataAgent agent = mock(FlightDataAgent.class);
        when(agent.sourceName()).thenReturn("opensky");
        when(agent.pollGlobal()).thenReturn(List.of(), List.of(report()));
        when(persistenceService.persistBatch(any(), any())).thenReturn(7);

        AgentOrchestrator orchestrator = orchestrator(List.of(agent));
        orchestrator.pollGlobalSweep();
        assertThat(sweepHealth.lastSweepAt()).isEmpty();
        assertThat(sweepHealth.consecutiveSkips()).isEqualTo(1);

        orchestrator.pollGlobalSweep();
        assertThat(sweepHealth.lastSweepAt()).isPresent();
        assertThat(sweepHealth.lastSweepRows()).isEqualTo(7);
        assertThat(sweepHealth.consecutiveSkips()).isZero();
    }

    @Test
    void rowsThatAllDeduplicated_areNotFreshness() {
        FlightDataAgent agent = mock(FlightDataAgent.class);
        when(agent.sourceName()).thenReturn("opensky");
        when(agent.pollGlobal()).thenReturn(List.of(report()));
        when(persistenceService.persistBatch(any(), any())).thenReturn(0); // every row already known

        orchestrator(List.of(agent)).pollGlobalSweep();

        assertThat(sweepHealth.lastSweepAt()).isEmpty();
        assertThat(sweepHealth.consecutiveSkips()).isEqualTo(1);
    }

    @Test
    void oneFailingSource_doesNotStopAnotherFromWritingRows() {
        FlightDataAgent bad = mock(FlightDataAgent.class);
        when(bad.sourceName()).thenReturn("bad");
        when(bad.pollGlobal()).thenThrow(new RuntimeException("upstream down"));
        FlightDataAgent good = mock(FlightDataAgent.class);
        when(good.sourceName()).thenReturn("opensky");
        when(good.pollGlobal()).thenReturn(List.of(report()));
        when(persistenceService.persistBatch(eq("opensky"), any())).thenReturn(3);

        orchestrator(List.of(bad, good)).pollGlobalSweep();

        assertThat(sweepHealth.lastSweepAt()).isPresent();
        assertThat(sweepHealth.lastSweepRows()).isEqualTo(3);
        assertThat(sweepHealth.consecutiveSkips()).isZero();
    }
}
