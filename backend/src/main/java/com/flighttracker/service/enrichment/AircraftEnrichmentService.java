package com.flighttracker.service.enrichment;

import com.flighttracker.model.Aircraft;
import com.flighttracker.repository.AircraftRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Async;
import org.springframework.stereotype.Service;

import java.time.Clock;
import java.time.Duration;
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
 * Origin/destination is no longer stored per aircraft (it used to be
 * fetched once and kept forever, so an airframe kept showing its first
 * leg's destination on every later flight). See routeFor(): the route
 * follows the current callsign (CallsignRouteService), and OpenSky's
 * per-aircraft fallback only ever answers for the current leg. The
 * aircraft table's route columns are legacy and no longer read.
 */
@Service
public class AircraftEnrichmentService {

    private static final Logger log = LoggerFactory.getLogger(AircraftEnrichmentService.class);

    private final AircraftRepository aircraftRepository;
    private final AdsbdbClient adsbdbClient;
    private final OpenSkyFlightsClient flightsClient;
    private final CallsignRouteService callsignRoutes;
    private final Clock clock;

    // After an OpenSky fallback lookup for a leg comes back empty, don't ask
    // again for this long (see LegRouteFallback).
    static final Duration FALLBACK_RETRY_AFTER_MISS = LegRouteFallback.RETRY_AFTER_MISS;

    private final LegRouteFallback fallbackRoutes;

    public AircraftEnrichmentService(AircraftRepository aircraftRepository,
                                      AdsbdbClient adsbdbClient,
                                      OpenSkyFlightsClient flightsClient,
                                      AirportLookupService airportLookupService,
                                      CallsignRouteService callsignRoutes,
                                      Clock clock) {
        this.aircraftRepository = aircraftRepository;
        this.adsbdbClient = adsbdbClient;
        this.flightsClient = flightsClient;
        this.callsignRoutes = callsignRoutes;
        this.clock = clock;
        this.fallbackRoutes = new LegRouteFallback(flightsClient, airportLookupService, clock);
    }

    @Async("enrichmentExecutor")
    public void enrichNewAircraft(String icao24, String callsign) {
        enrichSynchronously(icao24, callsign);
    }

    /** Blocking — only call this from a single user-triggered request, never in bulk. */
    public void enrichSynchronously(String icao24, String callsign) {
        Optional<AircraftInfo> info = adsbdbClient.fetchAircraftInfo(icao24);
        // Warms the callsign cache so the dossier/search have a route ready.
        callsignRoutes.resolve(callsign);
        // Aircraft is immutable (cloud migration A2) — no more
        // load/mutate-fields/save; updateEnrichment issues a single
        // targeted UPDATE, only touching the columns a lookup actually
        // found a value for (see that method's own javadoc). Runs
        // unconditionally, even when the lookup came back empty: it still
        // needs to stamp metadataFetchedAt so a data-less aircraft (no
        // adsbdb record) doesn't trigger a fresh external lookup every
        // single time its dossier is viewed again. Route columns are no
        // longer written (always null) — see the class javadoc.
        AircraftInfo i = info.orElse(null);
        aircraftRepository.updateEnrichment(icao24,
                i == null ? null : i.model(),
                i == null ? null : i.registration(),
                i == null ? null : i.operator(),
                null, null, null, null, null, null, null, null,
                clock.instant());
        if (info.isEmpty()) {
            log.debug("No aircraft metadata found for {}", icao24);
        }
    }

    /**
     * Confirms via OpenSkyFlightsClient.confirmLanded whether the leg that
     * produced {@code lastObservedAt} has actually ended at an airport,
     * rather than trusting AircraftController's own silence+descending
     * heuristic alone — only worth calling once that heuristic already
     * presumes landed (see LiveVisibilityWindows.PRESUMED_LANDED_SILENCE).
     * Blocking, same tradeoff as enrichSynchronously: called from a single
     * user-triggered dossier request, not in bulk.
     *
     * At most one OpenSky call per distinct last-known report:
     * landingCheckObservedAt records which report this aircraft was last
     * checked against, so a dossier viewed repeatedly while no new report
     * has arrived (the aircraft really has gone quiet) doesn't re-hit
     * OpenSky every time — it only checks again once a genuinely new
     * report (most likely a new leg entirely) shows up, which also means a
     * stale confirmation from a previous leg is never returned: the
     * equality check below fails as soon as observedAt has moved on.
     *
     * @return the confirmed landing time, whether just checked or cached
     *         from checking this same report before; empty if OpenSky
     *         doesn't (yet) show this leg as landed.
     */
    public Optional<Instant> checkLandingIfNeeded(String icao24, Instant lastObservedAt) {
        Aircraft aircraft = aircraftRepository.findById(icao24).orElse(null);
        if (aircraft == null) return Optional.empty();
        if (lastObservedAt.equals(aircraft.landingCheckObservedAt())) {
            return Optional.ofNullable(aircraft.landingConfirmedAt());
        }

        Optional<Instant> confirmedAt = flightsClient.confirmLanded(icao24, lastObservedAt);
        aircraftRepository.updateLandingCheck(icao24, lastObservedAt, confirmedAt.orElse(null));
        return confirmedAt;
    }

    /**
     * The route of the flight this aircraft is on now: by callsign first
     * (schedule-based, resolves airborne flights, changes with each leg's
     * flight number), else OpenSky's record for the leg that started at
     * {@code legStart} — never an earlier leg's. Empty is the honest answer
     * when neither knows; the dossier shows "—" rather than a stale airport.
     * Blocking: may make one adsbdb and one OpenSky call, so only for a
     * single user-triggered dossier request.
     */
    public Optional<Route> routeFor(String icao24, String callsign, Instant legStart) {
        Optional<Route> byCallsign = callsignRoutes.resolve(callsign);
        if (byCallsign.isPresent()) return byCallsign;
        if (legStart == null) return Optional.empty();

        return fallbackRoutes.routeFor(icao24, legStart);
    }

    /**
     * Route already known for this callsign, or for this aircraft's current
     * leg via the fallback, without calling out — for bulk readers like
     * airport search.
     */
    public Optional<Route> knownRoute(String icao24, String callsign) {
        Optional<Route> byCallsign = callsignRoutes.cached(callsign);
        if (byCallsign.isPresent()) return byCallsign;
        return fallbackRoutes.known(icao24);
    }
}
