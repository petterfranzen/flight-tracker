package com.flighttracker.service.agent;

import com.flighttracker.model.Aircraft;
import com.flighttracker.repository.AircraftRepository;
import com.flighttracker.repository.FlightPositionRepository;
import com.flighttracker.service.PollWindowService;
import com.flighttracker.service.enrichment.AircraftEnrichmentService;
import jakarta.annotation.PostConstruct;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.annotation.Profile;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Spring auto-injects every FlightDataAgent bean here — registering a new
 * agent is just adding a @Component that implements the interface, nothing
 * to wire up by hand. Each poll cycle fans out to all agents, normalises
 * their reports, and writes to the append-only flight_position table.
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
    private static final String POSITION_NOTIFY_CHANNEL = "flight_position";

    private final List<FlightDataAgent> agents;
    private final AircraftRepository aircraftRepository;
    private final FlightPositionRepository positionRepository;
    private final AircraftEnrichmentService enrichmentService;
    private final PollWindowService pollWindowService;
    private final JdbcTemplate jdbcTemplate;

    // Local-only, just to avoid a log line every poll cycle while the
    // window stays closed — the authoritative state is PollWindowService.
    private final AtomicBoolean windowOpenLastCycle = new AtomicBoolean(true);

    public AgentOrchestrator(List<FlightDataAgent> agents,
                              AircraftRepository aircraftRepository,
                              FlightPositionRepository positionRepository,
                              AircraftEnrichmentService enrichmentService,
                              PollWindowService pollWindowService,
                              JdbcTemplate jdbcTemplate) {
        this.agents = agents;
        this.aircraftRepository = aircraftRepository;
        this.positionRepository = positionRepository;
        this.enrichmentService = enrichmentService;
        this.pollWindowService = pollWindowService;
        this.jdbcTemplate = jdbcTemplate;
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
                // The "api" container's WebSocket clients live in a separate
                // process now, so there's no LiveFeedBroadcaster to call
                // directly here — NOTIFY instead (see
                // PositionNotificationListener on the api side). Postgres
                // only delivers this to LISTENers once *this* transaction
                // commits, and only the row id is sent (LISTEN/NOTIFY has an
                // 8000-byte payload cap, and the listener can cheaply look
                // the row up itself).
                jdbcTemplate.execute("NOTIFY " + POSITION_NOTIFY_CHANNEL + ", '" + inserted.get().getId() + "'");
                written++;
            }
            // else: another agent already reported this exact (icao24, observed_at) tick — expected, skip
        }
        log.info("{}: wrote {} of {} position reports", sourceName, written, reports.size());
        return newAircraft;
    }
}
