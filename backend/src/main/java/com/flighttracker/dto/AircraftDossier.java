package com.flighttracker.dto;

/**
 * Aircraft type/registration/operator and origin/destination, for the
 * map's Field Log panel. Any field may be null.
 *
 * flightMinutes/etaMinutes/cruisingAltitudeM/flightPhase are all computed
 * on the fly (AircraftController), not stored — the first two need "now",
 * so a cached value would go stale immediately; the altitude fields are
 * derived from position history that keeps growing:
 *  - flightMinutes: elapsed time since this leg's takeoff (see
 *    FlightPositionRepository.findCurrentLegTakeoffTime). Null if we have
 *    no airborne history at all for this aircraft.
 *  - etaMinutes: great-circle distance from the current position to the
 *    destination airport, divided by current groundspeed. Null whenever
 *    any input is missing or the estimate wouldn't be meaningful —
 *    aircraft already on the ground, destination coordinates unknown (no
 *    route at all for this callsign, or a destination code neither adsbdb
 *    nor the local airport reference table — see AirportLookupService —
 *    has coordinates for), or groundspeed too low to divide by sanely.
 *  - cruisingAltitudeM: highest altitude reached so far in the current leg
 *    (see FlightPositionRepository.findMaxAltitudeSince). Still meaningful
 *    after landing (that flight's peak); null only if there's no airborne
 *    history for this leg at all.
 *  - flightPhase: one of FlightPhaseClassifier.FlightPhase's names
 *    (ON_GROUND/TAKING_OFF/CLIMBING/LEVEL/DESCENDING/LANDING), from the
 *    actual altitude trend, not a single instantaneous vertical_rate_ms
 *    reading — see FlightPhaseClassifier.
 *  - staleExplanation: a plain-language guess at what a since-gone-quiet
 *    aircraft is probably doing, from flightPhase and (when known)
 *    distance to the destination airport at last report — NOT from how
 *    long ago that report was (the frontend already knows that, and
 *    decides for itself when "long ago" is worth showing this at all; see
 *    STALE_POSITION_WARN_MS in FlightMap.tsx). Deliberately not a blanket
 *    "probably landed": an aircraft last seen airborne, at altitude, and
 *    nowhere near its destination going quiet is a coverage gap far more
 *    likely than a landing, and saying otherwise is actively misleading —
 *    see AircraftController.describeLikelyStatus for the actual rule.
 */
public record AircraftDossier(
        String icao24,
        String registration,
        String model,
        String operator,
        String originAirport,
        String originAirportName,
        String destinationAirport,
        String destinationAirportName,
        Long flightMinutes,
        Long etaMinutes,
        Double cruisingAltitudeM,
        String flightPhase,
        String staleExplanation
) { }
