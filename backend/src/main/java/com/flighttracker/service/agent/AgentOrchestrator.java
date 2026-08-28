package com.flighttracker.service.agent;

import com.flighttracker.service.PollWindowService;
import com.flighttracker.service.enrichment.AircraftEnrichmentService;
import jakarta.annotation.PostConstruct;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.annotation.Profile;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Spring auto-injects every FlightDataAgent bean here — registering a new
 * agent is just adding a @Component that implements the interface, nothing
 * to wire up by hand. Each poll cycle fans out to all agents, normalises
 * their reports, and hands them to PositionPersistenceService to write.
 *
 * Only runs in the "agent" container — see PollWindowService and
 * PositionNotificationListener for how it coordinates with the "api"
 * container (poll-window state and the live WebSocket feed respectively)
 * now that they're separate processes.
 */
@Service
@Profile("agent")
public class AgentOrchestrator {

    private static final Logger log = LoggerFactory.getLogger(AgentOrchestrator.class);

    private final List<FlightDataAgent> agents;
    private final PositionPersistenceService persistenceService;
    private final AircraftEnrichmentService enrichmentService;
    private final PollWindowService pollWindowService;

    // Local-only, just to avoid a log line every poll cycle while the
    // window stays closed — the authoritative state is PollWindowService.
    private final AtomicBoolean windowOpenLastCycle = new AtomicBoolean(true);

    public AgentOrchestrator(List<FlightDataAgent> agents,
                              PositionPersistenceService persistenceService,
                              AircraftEnrichmentService enrichmentService,
                              PollWindowService pollWindowService) {
        this.agents = agents;
        this.persistenceService = persistenceService;
        this.enrichmentService = enrichmentService;
        this.pollWindowService = pollWindowService;
    }

    // Opens the window on every container boot, same as the old in-memory
    // default did — so a fresh deployment shows live traffic immediately
    // without needing the UI's restart button first.
    @PostConstruct
    void openWindowOnStartup() {
        pollWindowService.restart();
    }

    @Scheduled(fixedDelayString = "#{${flighttracker.agents.poll-interval-seconds} * 1000}")
    public void pollAll() {
        if (!pollWindowService.isActive()) {
            if (windowOpenLastCycle.compareAndSet(true, false)) {
                log.info("Polling window elapsed — stopped until restarted via POST /api/agents/restart");
            }
            return;
        }
        windowOpenLastCycle.set(true);
        for (FlightDataAgent agent : agents) {
            try {
                List<RawPositionReport> reports = agent.poll();
                if (!reports.isEmpty()) {
                    List<RawPositionReport> newAircraft = persistenceService.persist(agent.sourceName(), reports);
                    // Fired after persist()'s transaction has committed (we're back
                    // on the caller now), not from inside it — the enrichment lookup
                    // runs on a separate @Async thread, so kicking it off mid-transaction
                    // risks that thread querying for the aircraft row before this
                    // transaction has actually committed it.
                    newAircraft.forEach(r -> enrichmentService.enrichNewAircraft(r.icao24(), r.callsign()));
                }
            } catch (Exception e) {
                log.warn("Agent {} failed this cycle", agent.sourceName(), e);
            }
        }
    }

    // Deliberately not gated by pollWindowService — this runs always,
    // independent of whether anyone's actively watching the map, so the
    // database has recent global coverage even for aircraft nobody's
    // viewport has ever hot-polled. Each agent decides for itself whether
    // it supports this (FlightDataAgent.pollGlobal() defaults to empty).
    @Scheduled(fixedDelayString = "#{${flighttracker.agents.global-sweep-interval-seconds:300} * 1000}")
    public void pollGlobalSweep() {
        for (FlightDataAgent agent : agents) {
            try {
                List<RawPositionReport> reports = agent.pollGlobal();
                if (!reports.isEmpty()) {
                    List<RawPositionReport> newAircraft = persistenceService.persist(agent.sourceName(), reports);
                    newAircraft.forEach(r -> enrichmentService.enrichNewAircraft(r.icao24(), r.callsign()));
                }
            } catch (Exception e) {
                log.warn("Agent {} global sweep failed", agent.sourceName(), e);
            }
        }
    }
}
