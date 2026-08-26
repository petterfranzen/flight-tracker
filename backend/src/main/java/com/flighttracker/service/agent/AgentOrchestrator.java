package com.flighttracker.service.agent;

import com.flighttracker.dto.PollingStatus;
import com.flighttracker.model.Aircraft;
import com.flighttracker.repository.AircraftRepository;
import com.flighttracker.repository.FlightPositionRepository;
import com.flighttracker.service.LiveFeedBroadcaster;
import com.flighttracker.service.enrichment.AircraftEnrichmentService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Spring auto-injects every FlightDataAgent bean here — registering a new
 * agent is just adding a @Component that implements the interface, nothing
 * to wire up by hand. Each poll cycle fans out to all agents, normalises
 * their reports, and writes to the append-only flight_position table.
 */
@Service
public class AgentOrchestrator {

    private static final Logger log = LoggerFactory.getLogger(AgentOrchestrator.class);

    private final List<FlightDataAgent> agents;
    private final AircraftRepository aircraftRepository;
    private final FlightPositionRepository positionRepository;
    private final LiveFeedBroadcaster broadcaster;
    private final AircraftEnrichmentService enrichmentService;
    private final Duration pollWindow;

    // Bounds how long polling stays active per activation, so this doesn't
    // run unattended 24/7 and burn through OpenSky's daily anonymous credit
    // budget (we've exhausted it before — see OpenSkyAgent/OpenSkyFlightsClient)
    // on a NAS deployment nobody's watching. Starts open on boot so the app
    // shows live traffic immediately; once it elapses, /api/agents/restart
    // (wired to a UI button) is the only way to reopen it.
    private final AtomicReference<Instant> activeUntil;
    private final AtomicBoolean windowOpen = new AtomicBoolean(true);

    public AgentOrchestrator(List<FlightDataAgent> agents,
                              AircraftRepository aircraftRepository,
                              FlightPositionRepository positionRepository,
                              LiveFeedBroadcaster broadcaster,
                              AircraftEnrichmentService enrichmentService,
                              @Value("${flighttracker.agents.poll-window-seconds}") long pollWindowSeconds) {
        this.agents = agents;
        this.aircraftRepository = aircraftRepository;
        this.positionRepository = positionRepository;
        this.broadcaster = broadcaster;
        this.enrichmentService = enrichmentService;
        this.pollWindow = Duration.ofSeconds(pollWindowSeconds);
        this.activeUntil = new AtomicReference<>(Instant.now().plus(pollWindow));
    }

    @Scheduled(fixedDelayString = "#{${flighttracker.agents.poll-interval-seconds} * 1000}")
    public void pollAll() {
        if (Instant.now().isAfter(activeUntil.get())) {
            if (windowOpen.compareAndSet(true, false)) {
                log.info("Polling window elapsed after {} — stopped until restarted via POST /api/agents/restart", pollWindow);
            }
            return;
        }
        for (FlightDataAgent agent : agents) {
            try {
                List<RawPositionReport> reports = agent.poll();
                if (!reports.isEmpty()) {
                    List<RawPositionReport> newAircraft = persist(agent.sourceName(), reports);
                    // Fired after persist()'s transaction has committed (we're back
                    // on the caller now), not from inside it — the enrichment lookup
                    // runs on a separate @Async thread, so kicking it off mid-transaction
                    // risks that thread querying for the aircraft row before this
                    // transaction has actually committed it.
                    newAircraft.forEach(r -> enrichmentService.enrichNewAircraft(r.icao24(), r.callsign()));
                }
            } catch (Exception e) {
                log.warn("Agent {} failed this cycle: {}", agent.sourceName(), e.toString());
            }
        }
    }

    /** Reopens the polling window for another {@code pollWindow} from now. */
    public void restartPolling() {
        activeUntil.set(Instant.now().plus(pollWindow));
        windowOpen.set(true);
        log.info("Polling restarted — active for {}", pollWindow);
    }

    public PollingStatus status() {
        Instant now = Instant.now();
        Instant until = activeUntil.get();
        boolean active = now.isBefore(until);
        long secondsRemaining = active ? Duration.between(now, until).toSeconds() : 0;
        return new PollingStatus(active, secondsRemaining);
    }

    /** Returns the reports for icao24s that were newly seen this cycle (not already known aircraft). */
    @Transactional
    protected List<RawPositionReport> persist(String sourceName, List<RawPositionReport> reports) {
        int written = 0;
        List<RawPositionReport> newAircraft = new ArrayList<>();
        for (RawPositionReport r : reports) {
            aircraftRepository.findById(r.icao24()).ifPresentOrElse(
                    Aircraft::touch,
                    () -> {
                        aircraftRepository.save(new Aircraft(r.icao24()));
                        newAircraft.add(r);
                    }
            );
            var inserted = positionRepository.insertIgnoringDuplicate(
                    r.icao24(), r.callsign(), r.observedAt(),
                    r.latitude(), r.longitude(), r.altitudeM(),
                    r.velocityMs(), r.headingDeg(), r.verticalRateMs(),
                    r.onGround(), sourceName);
            if (inserted.isPresent()) {
                broadcaster.publish(inserted.get());
                written++;
            }
            // else: another agent already reported this exact (icao24, observed_at) tick — expected, skip
        }
        log.info("{}: wrote {} of {} position reports", sourceName, written, reports.size());
        return newAircraft;
    }
}
