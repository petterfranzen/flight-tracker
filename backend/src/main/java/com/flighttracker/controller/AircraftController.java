package com.flighttracker.controller;

import com.flighttracker.dto.AircraftDossier;
import com.flighttracker.dto.TrackStatus;
import com.flighttracker.model.Aircraft;
import com.flighttracker.model.Airport;
import com.flighttracker.model.FlightPosition;
import com.flighttracker.repository.AircraftRepository;
import com.flighttracker.repository.FlightPositionRepository;
import com.flighttracker.service.FlightPhaseClassifier;
import com.flighttracker.service.LiveVisibilityWindows;
import com.flighttracker.service.confirmation.ConfirmationStore;
import com.flighttracker.service.enrichment.AircraftEnrichmentService;
import com.flighttracker.service.enrichment.AirportLookupService;
import com.flighttracker.service.coverage.TrackState;
import com.flighttracker.service.enrichment.Route;
import com.flighttracker.service.live.LiveStateStore;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.EnumSet;
import java.util.Locale;
import java.util.Optional;
import java.util.Set;

@RestController
@RequestMapping("/api/aircraft")
public class AircraftController {

    private final AircraftRepository aircraftRepository;
    private final FlightPositionRepository positionRepository;
    private final LiveStateStore liveStateStore;
    private final AircraftEnrichmentService enrichmentService;
    private final AirportLookupService airportLookupService;
    private final ConfirmationStore confirmationStore;
    private final Clock clock;

    public AircraftController(AircraftRepository aircraftRepository,
                               FlightPositionRepository positionRepository,
                               LiveStateStore liveStateStore,
                               AircraftEnrichmentService enrichmentService,
                               AirportLookupService airportLookupService,
                               ConfirmationStore confirmationStore,
                               Clock clock) {
        this.aircraftRepository = aircraftRepository;
        this.positionRepository = positionRepository;
        this.liveStateStore = liveStateStore;
        this.enrichmentService = enrichmentService;
        this.airportLookupService = airportLookupService;
        this.confirmationStore = confirmationStore;
        this.clock = clock;
    }

    /**
     * Dossier fields (type/registration/operator/origin/destination) for one
     * aircraft. Aircraft the hot poll sees get enriched eagerly and
     * asynchronously (AgentOrchestrator.pollAll); aircraft only the global
     * sweep has found are never eagerly enriched (that would mean enriching
     * several thousand aircraft nobody's looking at every sweep — see
     * AgentOrchestrator.pollGlobalSweep for why that doesn't scale), so this
     * does it lazily and synchronously right here instead, the moment
     * someone actually asks. That means this request can take a bit longer
     * than a typical GET the first time a given aircraft's dossier is
     * opened — acceptable for a single user-initiated lookup, unlike the
     * bulk case this deliberately avoids.
     */
    @GetMapping("/{icao24}")
    public ResponseEntity<AircraftDossier> get(@PathVariable String icao24) {
        icao24 = normalizeIcao24(icao24);
        Aircraft aircraft = aircraftRepository.findById(icao24).orElse(null);
        if (aircraft == null) return ResponseEntity.notFound().build();

        if (aircraft.metadataFetchedAt() == null) {
            String callsign = liveStateStore.findLatestCallsign(icao24).orElse(null);
            enrichmentService.enrichSynchronously(icao24, callsign);
            aircraft = aircraftRepository.findById(icao24).orElse(aircraft);
        }

        return ResponseEntity.ok(toDossier(aircraft));
    }

    // icao24 is stored lower case; a mixed-case URL must still find it.
    private static String normalizeIcao24(String icao24) {
        return icao24.trim().toLowerCase(Locale.ROOT);
    }

    // How far back FlightPhaseClassifier's "earlier" altitude reference
    // point looks — long enough that normal report-to-report jitter
    // averages out (a single ~18s hot-poll tick isn't representative of a
    // real trend), short enough to still reflect what the aircraft is
    // doing *right now*, not a stale phase from many minutes ago.
    private static final Duration PHASE_TREND_WINDOW = Duration.ofMinutes(3);

    // findCurrentLegTakeoffTime's honest answer for "when did the current
    // leg start" is "the earliest airborne report since this aircraft was
    // last seen grounded" — for an aircraft this system has only ever
    // observed airborne (a tracking gap, or genuinely never having caught
    // it on the ground), that can be many hours or even days earlier than
    // any real single flight leg, producing a flightMinutes value that's
    // technically the honest answer to that query but not a plausible real
    // flight duration. The longest real nonstop commercial flights run
    // under 20 hours; comfortably past that, showing the number at all is
    // actively misleading rather than a smaller-confidence estimate, so it
    // reads as unknown instead.
    private static final long MAX_PLAUSIBLE_FLIGHT_MINUTES = 20 * 60;

    /**
     * The old silence rule: a descending aircraft quiet for longer than
     * PRESUMED_LANDED_SILENCE is presumed landed. It applies to every
     * coverage-gap state but LANDED_INFERRED, which has its own touchdown
     * time; in particular a COVERAGE_LOST descender with a low landing
     * probability still stops counting flight minutes.
     */
    static boolean silentWhileDescending(TrackState state, boolean descendingOrLanding, Duration silence) {
        return state != TrackState.LANDED_INFERRED && descendingOrLanding
                && silence.compareTo(LiveVisibilityWindows.PRESUMED_LANDED_SILENCE) > 0;
    }

    private AircraftDossier toDossier(Aircraft stored) {
        Instant now = clock.instant();
        Optional<Instant> legStart = positionRepository.findCurrentLegTakeoffTime(stored.icao24());
        FlightPosition current = liveStateStore.findLatestPosition(stored.icao24()).orElse(null);
        Route route = enrichmentService.routeFor(stored.icao24(), currentCallsign(stored.icao24(), current),
                legStart.orElse(null)).orElse(null);
        Aircraft a = withRoute(stored, route);
        // `current` is coalesced with the estimate (the ETA calc benefits from
        // the more accurate live position); the coverage-gap state comes from
        // the raw live entry, the same TrackStatus /status serves.
        TrackStatus status = liveStateStore.get(a.icao24())
                .map(live -> TrackStatus.from(live, confirmationStore.forAircraft(live)))
                .orElse(null);
        FlightPhaseClassifier.FlightPhase phase = classifyPhase(a.icao24(), current, legStart);
        LandingAssessment landing = LandingAssessment.assess(current, status, phase, now);
        Long flightMinutes = legStart.map(takeoff -> Duration.between(takeoff, landing.flightEnd()).toMinutes())
                .filter(minutes -> minutes <= MAX_PLAUSIBLE_FLIGHT_MINUTES)
                .orElse(null);
        Double cruisingAltitudeM = legStart.flatMap(ls -> positionRepository.findMaxAltitudeSince(a.icao24(), ls))
                .orElse(null);

        // Only worth spending an OpenSky call on once our own heuristic
        // already presumes landed — see AircraftEnrichmentService.
        // checkLandingIfNeeded for the throttling/caching behind this.
        Optional<Instant> landingConfirmedAt = landing.worthCheckingLanding()
                ? enrichmentService.checkLandingIfNeeded(a.icao24(), current.observedAt())
                : Optional.empty();
        String staleExplanation = describeStatus(status, a, landingConfirmedAt.isPresent());

        AirportDisplay origin = resolveAirport(a.originAirport(), a.originAirportName());
        AirportDisplay destination = resolveAirport(a.destinationAirport(), a.destinationAirportName());

        return new AircraftDossier(
                a.icao24(), a.registration(), a.model(), a.operator(),
                a.originAirport(), origin.name(), origin.iataCode(),
                a.destinationAirport(), destination.name(), destination.iataCode(),
                flightMinutes, EtaEstimate.minutes(current, a), cruisingAltitudeM, phase == null ? null : phase.name(),
                staleExplanation, legStart.orElse(null));
    }

    // The route of *this* flight — by its current callsign, or OpenSky's
    // record for the current leg — never the stored per-aircraft route,
    // which was whatever leg the airframe was first enriched on.
    private String currentCallsign(String icao24, FlightPosition current) {
        if (current != null && current.callsign() != null) return current.callsign();
        return liveStateStore.findLatestCallsign(icao24).orElse(null);
    }

    /**
     * Skips the earlier-altitude lookup entirely when on the ground —
     * FlightPhaseClassifier only needs that reference to distinguish
     * climbing/descending/level, none of which matter once on_ground makes
     * the phase ON_GROUND outright.
     *
     * <p>Anchored to current.observedAt(), not `now`: for a stale aircraft
     * (the whole point staleExplanation and the presumed-landed check exist
     * for) `now` is well past the last real report, so "now - 3min" is still
     * after that report — the query would just find that same latest reading
     * again as its own "earlier" reference, comparing it to itself (delta 0,
     * always reads LEVEL). Anchoring to when the data actually is makes the
     * window relative to the aircraft's own timeline instead of the server's.
     */
    private FlightPhaseClassifier.FlightPhase classifyPhase(String icao24, FlightPosition current,
                                                            Optional<Instant> legStart) {
        if (current == null) return null;
        Double earlierAltitude = current.onGround() ? null
                : legStart.flatMap(ls -> positionRepository.findAltitudeAtOrBefore(
                        icao24, ls, current.observedAt().minus(PHASE_TREND_WINDOW))).orElse(null);
        return FlightPhaseClassifier.classify(current.onGround(), current.altitudeM(), earlierAltitude);
    }

    /** No route known reads as no route at all: every origin/destination field null. */
    private static final Route NO_ROUTE = new Route(null, null, null, null, null, null, null, null);

    private static Aircraft withRoute(Aircraft a, Route route) {
        Route r = route == null ? NO_ROUTE : route;
        return new Aircraft(a.icao24(), a.registration(), a.model(), a.operator(),
                r.originAirport(), r.originAirportName(),
                r.destinationAirport(), r.destinationAirportName(),
                r.originAirportLat(), r.originAirportLon(),
                r.destinationAirportLat(), r.destinationAirportLon(),
                a.metadataFetchedAt(), a.landingCheckObservedAt(), a.landingConfirmedAt(),
                a.firstSeenAt(), a.lastSeenAt());
    }

    private record AirportDisplay(String name, String iataCode) {
        private static final AirportDisplay EMPTY = new AirportDisplay(null, null);
    }

    /**
     * Resolves a display name and IATA code for one ICAO route code —
     * always from the `airport` reference table for the IATA code (Aircraft
     * has nowhere to cache one: neither adsbdb nor OpenSky's fallback route
     * lookup ever returns one), and from that same table for the name too
     * whenever cachedName is null. cachedName itself came from
     * AircraftEnrichmentService.backfillNames, which only ever runs for
     * routes resolved via OpenSky's fallback (bare codes) — a route adsbdb
     * resolved directly already has a name and is used as-is here, but an
     * aircraft enriched before that backfill existed, or via a path that
     * never populates it, would otherwise show a bare ICAO code forever
     * despite the name being sitting right there in the reference table for
     * that code. Doing this live, on every dossier request, instead of
     * fixing it up in place sidesteps that staleness question entirely: a
     * cheap indexed local lookup (no external call, unlike the rest of
     * AircraftEnrichmentService), so there's no real cost to never trusting
     * a cached absence.
     */
    private AirportDisplay resolveAirport(String icaoCode, String cachedName) {
        if (icaoCode == null) return AirportDisplay.EMPTY;
        Optional<Airport> airport = airportLookupService.lookup(icaoCode);
        String name = cachedName != null ? cachedName : airport.map(Airport::name).orElse(null);
        String iataCode = airport.map(Airport::iataCode).orElse(null);
        return new AirportDisplay(name, iataCode);
    }

    /** States whose label already says where the landing came from. */
    private static final Set<TrackState> SOURCED_STATES =
            EnumSet.of(TrackState.ON_GROUND, TrackState.LANDED_CONFIRMED, TrackState.AT_GATE);

    /**
     * The dossier's status line (staleExplanation), worded from the same
     * {@link TrackStatus} that /status serves, or null while the aircraft is
     * simply LIVE. The OpenSky-confirmed landing keeps its own sourced
     * wording ahead of the inferred states.
     *
     * @param landingConfirmed whether AircraftEnrichmentService.
     *                         checkLandingIfNeeded got an actual OpenSky
     *                         confirmation for this leg.
     */
    private String describeStatus(TrackStatus status, Aircraft a, boolean landingConfirmed) {
        if (status == null) return null;
        if (landingConfirmed && !SOURCED_STATES.contains(status.state())) {
            String dest = a.destinationAirportName() != null ? a.destinationAirportName() : "its destination";
            return String.format("confirmed landed near %s (OpenSky's own flight record shows this leg ended)", dest);
        }
        return statusLabel(status);
    }

    /** The label table of docs/agents/PROGRESS.md; null for LIVE. */
    static String statusLabel(TrackStatus s) {
        return TrackStatusLabels.label(s);
    }

    /** The provider's display name, as the frontend shows it; an unknown id is shown as it is. */
    static String providerName(String id) {
        return TrackStatusLabels.providerName(id);
    }
}
