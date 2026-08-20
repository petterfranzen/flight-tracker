package com.flighttracker.service.agent;

import com.flighttracker.model.Aircraft;
import com.flighttracker.repository.AircraftRepository;
import com.flighttracker.repository.FlightPositionRepository;
import com.flighttracker.service.LiveFeedBroadcaster;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;

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

    public AgentOrchestrator(List<FlightDataAgent> agents,
                              AircraftRepository aircraftRepository,
                              FlightPositionRepository positionRepository,
                              LiveFeedBroadcaster broadcaster) {
        this.agents = agents;
        this.aircraftRepository = aircraftRepository;
        this.positionRepository = positionRepository;
        this.broadcaster = broadcaster;
    }

    @Scheduled(fixedDelayString = "#{${flighttracker.agents.poll-interval-seconds} * 1000}")
    public void pollAll() {
        for (FlightDataAgent agent : agents) {
            try {
                List<RawPositionReport> reports = agent.poll();
                if (!reports.isEmpty()) {
                    persist(agent.sourceName(), reports);
                }
            } catch (Exception e) {
                log.warn("Agent {} failed this cycle: {}", agent.sourceName(), e.toString());
            }
        }
    }

    @Transactional
    protected void persist(String sourceName, List<RawPositionReport> reports) {
        int written = 0;
        for (RawPositionReport r : reports) {
            aircraftRepository.findById(r.icao24()).ifPresentOrElse(
                    Aircraft::touch,
                    () -> aircraftRepository.save(new Aircraft(r.icao24()))
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
    }
}
