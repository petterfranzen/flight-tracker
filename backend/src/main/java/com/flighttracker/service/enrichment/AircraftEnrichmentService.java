package com.flighttracker.service.enrichment;

import com.flighttracker.model.Aircraft;
import com.flighttracker.repository.AircraftRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Async;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.Optional;

/**
 * Fills in the dossier fields (aircraft type/registration/operator,
 * origin/destination) for a newly-seen aircraft. Triggered once per
 * icao24, the first time AgentOrchestrator sees it — not on every poll —
 * both because these facts rarely change and because the OpenSky fallback
 * side is credit-limited (see OpenSkyFlightsClient).
 *
 * Runs @Async, off the scheduled-poll thread: these are outbound HTTP
 * calls to third parties, and the poll loop that creates new Aircraft rows
 * must not stall on them.
 *
 * One known tradeoff: origin/destination is fetched once and cached
 * indefinitely, so it can go stale if an aircraft we've seen before starts
 * a new flight later. Revisit with a TTL-based refresh if that matters in
 * practice — not done here to stay within OpenSky's daily credit budget.
 */
@Service
public class AircraftEnrichmentService {

    private static final Logger log = LoggerFactory.getLogger(AircraftEnrichmentService.class);

    private final AircraftRepository aircraftRepository;
    private final AdsbdbClient adsbdbClient;
    private final OpenSkyFlightsClient flightsClient;

    public AircraftEnrichmentService(AircraftRepository aircraftRepository,
                                      AdsbdbClient adsbdbClient,
                                      OpenSkyFlightsClient flightsClient) {
        this.aircraftRepository = aircraftRepository;
        this.adsbdbClient = adsbdbClient;
        this.flightsClient = flightsClient;
    }

    @Async("enrichmentExecutor")
    public void enrichNewAircraft(String icao24, String callsign) {
        Optional<AircraftInfo> info = adsbdbClient.fetchAircraftInfo(icao24);
        Optional<Route> route = fetchRoute(icao24, callsign);
        if (info.isEmpty() && route.isEmpty()) {
            log.debug("No enrichment data found for {}", icao24);
            return;
        }
        // findById/save each run in their own transaction (Spring Data's
        // SimpleJpaRepository), which is fine here — the mutation in
        // between is plain Java, not a second write needing atomicity
        // with the first.
        aircraftRepository.findById(icao24).ifPresent(aircraft -> {
            info.ifPresent(i -> {
                aircraft.setModel(i.model());
                aircraft.setRegistration(i.registration());
                aircraft.setOperator(i.operator());
            });
            route.ifPresent(r -> {
                aircraft.setOriginAirport(r.originAirport());
                aircraft.setDestinationAirport(r.destinationAirport());
            });
            aircraft.setMetadataFetchedAt(Instant.now());
            aircraftRepository.save(aircraft);
        });
    }

    /**
     * adsbdb's callsign-keyed flight-route database resolves destination
     * even for aircraft still airborne (schedule-based, not waiting on the
     * flight to land), so it's tried first. Falls back to OpenSky's
     * estimated-arrival-airport lookup for callsigns adsbdb doesn't
     * recognise — charter/GA/military — or when no callsign was reported.
     */
    private Optional<Route> fetchRoute(String icao24, String callsign) {
        if (callsign != null && !callsign.isBlank()) {
            Optional<Route> route = adsbdbClient.fetchRoute(callsign);
            if (route.isPresent()) return route;
        }
        return flightsClient.fetchRoute(icao24);
    }
}
