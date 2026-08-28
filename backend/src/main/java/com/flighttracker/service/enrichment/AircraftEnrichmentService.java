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
 * origin/destination) for one aircraft. Two entry points, for two very
 * different call patterns:
 *  - enrichNewAircraft(): @Async, fire-and-forget, triggered by
 *    AgentOrchestrator.pollAll() for a newly-seen aircraft — that's the
 *    poll loop's own thread, which must not stall on outbound HTTP calls.
 *  - enrichSynchronously(): blocking, triggered by AircraftController when
 *    someone's dossier request lands on an aircraft that's never been
 *    enriched — a single user-initiated lookup is fine to wait on.
 *
 * Deliberately NOT triggered eagerly for every aircraft
 * AgentOrchestrator.pollGlobalSweep() finds — a single sweep can surface
 * several thousand aircraft nobody's looking at, and eagerly enriching all
 * of them overwhelms both the async queue and the external APIs' rate
 * limits (confirmed live: under that load, 92% of all known aircraft never
 * got enriched at all). Enrichment for globally-swept aircraft happens
 * lazily instead, via enrichSynchronously, the moment someone actually
 * asks to see that aircraft's dossier.
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
        doEnrich(icao24, callsign);
    }

    /** Blocking — only call this from a single user-triggered request, never in bulk. */
    public void enrichSynchronously(String icao24, String callsign) {
        doEnrich(icao24, callsign);
    }

    private void doEnrich(String icao24, String callsign) {
        Optional<AircraftInfo> info = adsbdbClient.fetchAircraftInfo(icao24);
        Optional<Route> route = fetchRoute(icao24, callsign);
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
                aircraft.setOriginAirportName(r.originAirportName());
                aircraft.setDestinationAirport(r.destinationAirport());
                aircraft.setDestinationAirportName(r.destinationAirportName());
            });
            // Set even when nothing was found: marks the lookup as "tried",
            // so a data-less aircraft (no adsbdb record, no route) doesn't
            // trigger a fresh external lookup every single time its
            // dossier is viewed again.
            aircraft.setMetadataFetchedAt(Instant.now());
            aircraftRepository.save(aircraft);
        });
        if (info.isEmpty() && route.isEmpty()) {
            log.debug("No enrichment data found for {}", icao24);
        }
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
