package com.flighttracker.service.agent;

import com.flighttracker.model.Aircraft;
import com.flighttracker.repository.AircraftRepository;
import com.flighttracker.repository.FlightPositionRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.annotation.Profile;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.ArrayList;
import java.util.List;

/**
 * A separate bean from AgentOrchestrator specifically so persist() is
 * called across a real proxy boundary — @Transactional (and any other
 * Spring AOP advice) is applied via a dynamic proxy wrapping the bean, and
 * only takes effect on calls that go *through* that proxy. A same-class
 * self-invocation (AgentOrchestrator calling its own persist() method via
 * implicit `this`) bypasses the proxy entirely and silently runs with no
 * transaction — which worked by accident for the plain RETURNING-based
 * insert below, but broke loudly the moment upsertLatestPosition's
 * @Modifying executeUpdate() (which the JPA spec requires an active
 * transaction for) was added. This class exists so AgentOrchestrator has
 * to call persist() as a normal injected-bean call instead.
 */
@Service
@Profile("agent")
public class PositionPersistenceService {

    private static final Logger log = LoggerFactory.getLogger(PositionPersistenceService.class);
    private static final String POSITION_NOTIFY_CHANNEL = "flight_position";

    private final AircraftRepository aircraftRepository;
    private final FlightPositionRepository positionRepository;
    private final JdbcTemplate jdbcTemplate;

    public PositionPersistenceService(AircraftRepository aircraftRepository,
                                       FlightPositionRepository positionRepository,
                                       JdbcTemplate jdbcTemplate) {
        this.aircraftRepository = aircraftRepository;
        this.positionRepository = positionRepository;
        this.jdbcTemplate = jdbcTemplate;
    }

    /** True only on a genuinely fresh database — see AgentOrchestrator.seedOnStartup. */
    public boolean hasNoPositions() {
        return positionRepository.countLatestPositions() == 0;
    }

    /** Returns the reports for icao24s that were newly seen this cycle (not already known aircraft). */
    @Transactional
    public List<RawPositionReport> persist(String sourceName, List<RawPositionReport> reports) {
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
                // Keeps the "latest per aircraft" summary table (see its
                // schema.sql comment) in step with the append-only history —
                // every accepted report updates both, in the same transaction.
                positionRepository.upsertLatestPosition(
                        r.icao24(), r.callsign(), r.observedAt(),
                        r.latitude(), r.longitude(), r.altitudeM(),
                        r.velocityMs(), r.headingDeg(), r.verticalRateMs(),
                        r.onGround(), sourceName);
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
