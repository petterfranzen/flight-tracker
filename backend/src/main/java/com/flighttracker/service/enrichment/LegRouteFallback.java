package com.flighttracker.service.enrichment;

import com.flighttracker.model.Airport;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Function;

/**
 * OpenSky's per-aircraft route for the leg that started at a given time
 * (AircraftEnrichmentService.routeFor's fallback when the callsign has no
 * route), cached in memory per aircraft and leg. Never answers with an
 * earlier leg's route.
 */
final class LegRouteFallback {

    // After an OpenSky fallback lookup for a leg comes back empty, don't ask
    // again for this long: the flight usually only appears in OpenSky's
    // historical data once it has landed, and the endpoint costs credits.
    static final Duration RETRY_AFTER_MISS = Duration.ofMinutes(30);

    /** OpenSky fallback result for one aircraft's leg — in memory only. */
    private record Entry(Instant legStart, Route route, Instant fetchedAt) {
        /** Still the answer for this leg: a route found, or a miss too recent to ask again. */
        boolean answers(Instant leg, Instant now) {
            return legStart.equals(leg) && (route != null || !missExpired(now));
        }

        private boolean missExpired(Instant now) {
            return Duration.between(fetchedAt, now).compareTo(RETRY_AFTER_MISS) >= 0;
        }
    }

    private final OpenSkyFlightsClient flightsClient;
    private final AirportLookupService airportLookupService;
    private final Clock clock;
    private final Map<String, Entry> routes = new ConcurrentHashMap<>();

    LegRouteFallback(OpenSkyFlightsClient flightsClient, AirportLookupService airportLookupService, Clock clock) {
        this.flightsClient = flightsClient;
        this.airportLookupService = airportLookupService;
        this.clock = clock;
    }

    /** The route of the leg that started at {@code legStart}, from cache or one OpenSky call. */
    Optional<Route> routeFor(String icao24, Instant legStart) {
        Instant now = clock.instant();
        Entry cached = routes.get(icao24);
        if (cached != null && cached.answers(legStart, now)) {
            return Optional.ofNullable(cached.route());
        }
        Optional<Route> route = flightsClient.fetchRoute(icao24, legStart).map(this::backfillNames);
        routes.put(icao24, new Entry(legStart, route.orElse(null), now));
        return route;
    }

    /** The last fallback answer for this aircraft, without calling out. */
    Optional<Route> known(String icao24) {
        Entry cached = routes.get(icao24);
        return cached == null ? Optional.empty() : Optional.ofNullable(cached.route());
    }

    /**
     * Fills in a name/lat/lon for any code that has one but is missing the
     * other — in practice this only ever means the OpenSkyFlightsClient
     * fallback path (bare codes, no name/coordinates), since adsbdb always
     * returns both together or neither, but checking generically here means
     * this doesn't need to know which path produced the route. Local
     * static-table lookup (AirportLookupService), not another external
     * call, so this is cheap enough to always attempt.
     */
    private Route backfillNames(Route route) {
        Airport origin = lookupIfUnnamed(route.originAirportName(), route.originAirport());
        Airport destination = lookupIfUnnamed(route.destinationAirportName(), route.destinationAirport());
        if (origin == null && destination == null) return route;

        return new Route(
                route.originAirport(),
                field(origin, Airport::name, route.originAirportName()),
                field(origin, Airport::latitude, route.originAirportLat()),
                field(origin, Airport::longitude, route.originAirportLon()),
                route.destinationAirport(),
                field(destination, Airport::name, route.destinationAirportName()),
                field(destination, Airport::latitude, route.destinationAirportLat()),
                field(destination, Airport::longitude, route.destinationAirportLon()));
    }

    /** The airport for {@code code}, looked up only when the route has no name for it. */
    private Airport lookupIfUnnamed(String name, String code) {
        return name == null ? airportLookupService.lookup(code).orElse(null) : null;
    }

    private static <T> T field(Airport airport, Function<Airport, T> getter, T fallback) {
        return airport != null ? getter.apply(airport) : fallback;
    }
}
