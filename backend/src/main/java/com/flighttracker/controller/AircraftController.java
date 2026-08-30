package com.flighttracker.controller;

import com.flighttracker.dto.AircraftDossier;
import com.flighttracker.model.Aircraft;
import com.flighttracker.model.FlightPosition;
import com.flighttracker.repository.AircraftRepository;
import com.flighttracker.repository.FlightPositionRepository;
import com.flighttracker.service.FlightPhaseClassifier;
import com.flighttracker.service.LiveVisibilityWindows;
import com.flighttracker.service.enrichment.AircraftEnrichmentService;
import org.springframework.context.annotation.Profile;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.time.Duration;
import java.time.Instant;
import java.util.Optional;

@RestController
@RequestMapping("/api/aircraft")
@Profile("api")
public class AircraftController {

    private final AircraftRepository aircraftRepository;
    private final FlightPositionRepository positionRepository;
    private final AircraftEnrichmentService enrichmentService;

    public AircraftController(AircraftRepository aircraftRepository,
                               FlightPositionRepository positionRepository,
                               AircraftEnrichmentService enrichmentService) {
        this.aircraftRepository = aircraftRepository;
        this.positionRepository = positionRepository;
        this.enrichmentService = enrichmentService;
    }

    /**
     * Dossier fields (type/registration/operator/origin/destination) for one
     * aircraft. Aircraft the "agent" container's hot poll sees get enriched
     * eagerly and asynchronously (AgentOrchestrator.pollAll); aircraft only
     * the global sweep has found are never eagerly enriched (that would mean
     * enriching several thousand aircraft nobody's looking at every sweep —
     * see AgentOrchestrator.pollGlobalSweep for why that doesn't scale), so
     * this does it lazily and synchronously right here instead, the moment
     * someone actually asks. That means this request can take a bit longer
     * than a typical GET the first time a given aircraft's dossier is
     * opened — acceptable for a single user-initiated lookup, unlike the
     * bulk case this deliberately avoids.
     */
    @GetMapping("/{icao24}")
    public ResponseEntity<AircraftDossier> get(@PathVariable String icao24) {
        Aircraft aircraft = aircraftRepository.findById(icao24).orElse(null);
        if (aircraft == null) return ResponseEntity.notFound().build();

        if (aircraft.getMetadataFetchedAt() == null) {
            String callsign = positionRepository.findLatestCallsign(icao24).orElse(null);
            enrichmentService.enrichSynchronously(icao24, callsign);
            aircraft = aircraftRepository.findById(icao24).orElse(aircraft);
        }

        return ResponseEntity.ok(toDossier(aircraft));
    }

    // Below this, dividing distance by groundspeed stops being a
    // meaningful ETA and starts being a wild guess — taxiing speed, a
    // momentary lull in a stale/glitchy report, etc. Comfortably below
    // any real cruise or approach speed.
    private static final double MIN_ETA_GROUNDSPEED_MS = 20;

    // An ETA computed from a stale position isn't a smaller-confidence
    // version of the real answer, it's actively misleading — extrapolating
    // "still heading to the filed destination at the last known speed"
    // from data that's, say, 40 minutes old produces a perfectly
    // confident-looking number for a flight that may since have diverted,
    // landed, or gone anywhere.
    //
    // 10 minutes, not the frontend's tighter 2-minute staleness-*warning*
    // threshold (STALE_POSITION_WARN_MS in FlightMap.tsx) — that one's
    // about flagging a specifically-selected aircraft behaving oddly,
    // which is normally within someone's viewport and so on the fast
    // hot-poll cadence. This dossier endpoint gets called for *any*
    // aircraft, including ones only the global sweep has ever seen —
    // confirmed live: the vast majority of currently-tracked aircraft are
    // only as fresh as flighttracker.agents.global-sweep-interval-seconds
    // (default 300s), not the hot-poll's ~15s. 2 minutes there would have
    // nulled out ETA for nearly everyone, not just genuinely stale cases.
    private static final Duration MAX_ETA_POSITION_AGE = Duration.ofMinutes(10);

    // How far back FlightPhaseClassifier's "earlier" altitude reference
    // point looks — long enough that normal report-to-report jitter
    // averages out (a single ~15s hot-poll tick isn't representative of a
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
    // reads as unknown instead — same reasoning as MAX_ETA_POSITION_AGE
    // above, just for a different computed field.
    private static final long MAX_PLAUSIBLE_FLIGHT_MINUTES = 20 * 60;

    private AircraftDossier toDossier(Aircraft a) {
        Instant now = Instant.now();
        Optional<Instant> legStart = positionRepository.findCurrentLegTakeoffTime(a.getIcao24());
        FlightPosition current = positionRepository.findLatestPosition(a.getIcao24()).orElse(null);

        // Skip the lookup entirely when on the ground — FlightPhaseClassifier
        // only needs the earlier-altitude reference to distinguish
        // climbing/descending/level, none of which matter once on_ground
        // makes the phase ON_GROUND outright.
        //
        // Anchored to current.getObservedAt(), not `now`: for a stale
        // aircraft (the whole point staleExplanation and the presumed-landed
        // check below exist for) `now` is well past the last real report, so
        // "now - 3min" is still after that report — the query would just
        // find that same latest reading again as its own "earlier"
        // reference, comparing it to itself (delta 0, always reads LEVEL).
        // Anchoring to when the data actually is makes the window relative
        // to the aircraft's own timeline instead of the server's.
        Double earlierAltitudeForPhase = (current != null && !current.isOnGround())
                ? legStart.flatMap(ls -> positionRepository.findAltitudeAtOrBefore(
                        a.getIcao24(), ls, current.getObservedAt().minus(PHASE_TREND_WINDOW)))
                .orElse(null)
                : null;
        FlightPhaseClassifier.FlightPhase phase = current == null ? null
                : FlightPhaseClassifier.classify(current.isOnGround(), current.getAltitudeM(), earlierAltitudeForPhase);

        // Flight time stops counting at the last real report once the
        // aircraft is known (on_ground) or presumed (silent this long while
        // descending — see LiveVisibilityWindows.PRESUMED_LANDED_SILENCE,
        // shared with FlightController's live-view pruning) to have
        // landed, rather than running up against `now` indefinitely for a
        // flight that's actually long over. Still airborne (or too
        // recently silent to presume anything) keeps counting up to `now`
        // as before.
        boolean descendingOrLanding = phase == FlightPhaseClassifier.FlightPhase.DESCENDING
                || phase == FlightPhaseClassifier.FlightPhase.LANDING;
        boolean presumedLanded = current != null && (current.isOnGround()
                || (descendingOrLanding
                    && Duration.between(current.getObservedAt(), now).compareTo(LiveVisibilityWindows.PRESUMED_LANDED_SILENCE) > 0));
        Instant flightEnd = presumedLanded ? current.getObservedAt() : now;
        Long flightMinutes = legStart.map(takeoff -> Duration.between(takeoff, flightEnd).toMinutes())
                .filter(minutes -> minutes <= MAX_PLAUSIBLE_FLIGHT_MINUTES)
                .orElse(null);

        Long etaMinutes = null;
        if (current != null && a.getDestinationAirportLat() != null && a.getDestinationAirportLon() != null) {
            boolean fresh = Duration.between(current.getObservedAt(), now).compareTo(MAX_ETA_POSITION_AGE) <= 0;
            if (fresh && !current.isOnGround() && current.getVelocityMs() != null
                    && current.getVelocityMs() >= MIN_ETA_GROUNDSPEED_MS) {
                double distanceM = haversineMeters(
                        current.getLatitude(), current.getLongitude(),
                        a.getDestinationAirportLat(), a.getDestinationAirportLon());
                etaMinutes = Math.round(distanceM / current.getVelocityMs() / 60.0);
            }
        }

        Double cruisingAltitudeM = legStart.flatMap(ls -> positionRepository.findMaxAltitudeSince(a.getIcao24(), ls))
                .orElse(null);

        String staleExplanation = describeLikelyStatus(current, phase, a);

        return new AircraftDossier(
                a.getIcao24(), a.getRegistration(), a.getModel(), a.getOperator(),
                a.getOriginAirport(), a.getOriginAirportName(),
                a.getDestinationAirport(), a.getDestinationAirportName(),
                flightMinutes, etaMinutes, cruisingAltitudeM, phase == null ? null : phase.name(), staleExplanation);
    }

    // Close enough to the destination, combined with actually descending,
    // to say "landed" with real confidence rather than just "somewhere
    // below cruise" — short final approach / taxi-in range, not "in the
    // same country as the airport."
    private static final double NEAR_DESTINATION_KM = 30;

    /**
     * The frontend shows this only once a selected aircraft's position has
     * gone stale (see STALE_POSITION_WARN_MS in FlightMap.tsx) — this just
     * supplies the best guess at *why*, from what the last report actually
     * said, not from how long ago it was.
     */
    private String describeLikelyStatus(FlightPosition current, FlightPhaseClassifier.FlightPhase phase, Aircraft a) {
        if (current == null || phase == null) return null;

        if (phase == FlightPhaseClassifier.FlightPhase.ON_GROUND) {
            return "likely still on the ground (parked, taxiing, or out of ground-receiver range)";
        }

        boolean descendingOrLanding = phase == FlightPhaseClassifier.FlightPhase.DESCENDING
                || phase == FlightPhaseClassifier.FlightPhase.LANDING;

        Double distanceToDestKm = null;
        if (a.getDestinationAirportLat() != null && a.getDestinationAirportLon() != null) {
            distanceToDestKm = haversineMeters(
                    current.getLatitude(), current.getLongitude(),
                    a.getDestinationAirportLat(), a.getDestinationAirportLon()) / 1000.0;
        }

        if (descendingOrLanding && distanceToDestKm != null && distanceToDestKm <= NEAR_DESTINATION_KM) {
            String dest = a.getDestinationAirportName() != null ? a.getDestinationAirportName() : "its destination";
            return String.format("likely landed near %s (%.0f km away at last report, and descending)", dest, distanceToDestKm);
        }
        if (descendingOrLanding) {
            return "likely landed or on final approach — descending at last report";
        }
        // LEVEL/CLIMBING/TAKING_OFF far from (or with no known) destination:
        // still airborne is the better read than landed.
        return "likely still airborne — no recent updates could mean an ADS-B coverage gap"
                + " (open water, terrain, or a receiver dead zone) rather than having landed";
    }

    private static final double EARTH_RADIUS_M = 6_371_000;

    private static double haversineMeters(double lat1, double lon1, double lat2, double lon2) {
        double dLat = Math.toRadians(lat2 - lat1);
        double dLon = Math.toRadians(lon2 - lon1);
        double a = Math.sin(dLat / 2) * Math.sin(dLat / 2)
                + Math.cos(Math.toRadians(lat1)) * Math.cos(Math.toRadians(lat2))
                * Math.sin(dLon / 2) * Math.sin(dLon / 2);
        return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }
}
