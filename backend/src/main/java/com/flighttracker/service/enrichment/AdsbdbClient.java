package com.flighttracker.service.enrichment;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.client.HttpClientErrorException;
import org.springframework.web.client.RestClient;

import java.util.Optional;

/**
 * Looks up aircraft type/registration/operator by icao24 via adsbdb.com.
 * OpenSky's own per-icao24 metadata endpoint (/metadata/aircraft/icao/...)
 * was permanently removed (410 Gone, even authenticated) — adsbdb.com is a
 * free, no-auth alternative that still serves this. Best-effort: any
 * failure (including "we don't have this aircraft") degrades to empty
 * rather than propagating, since this is dossier enrichment, not core data.
 *
 * Used by both AgentOrchestrator's eager enrichment of newly hot-polled
 * aircraft and AircraftController's on-demand enrichment for aircraft the
 * global sweep found but nobody's looked at yet.
 */
@Component
public class AdsbdbClient {

    private static final Logger log = LoggerFactory.getLogger(AdsbdbClient.class);

    private final RestClient client;

    public AdsbdbClient(@Value("${flighttracker.enrichment.adsbdb-base-url:https://api.adsbdb.com/v0}") String baseUrl) {
        SimpleClientHttpRequestFactory requestFactory = new SimpleClientHttpRequestFactory();
        requestFactory.setConnectTimeout(5_000);
        requestFactory.setReadTimeout(10_000);
        this.client = RestClient.builder()
                .baseUrl(baseUrl)
                .requestFactory(requestFactory)
                .build();
    }

    /**
     * Looks up origin/destination for a callsign via adsbdb's flight-route
     * database (schedule-based, keyed by flight number — not live ADS-B
     * tracking). Unlike OpenSkyFlightsClient's estimated-arrival-airport
     * approach, this resolves destination even for aircraft still airborne,
     * since it's not waiting on the flight to actually land. Only handles
     * scheduled-airline callsigns; charter/GA/military callsigns won't
     * resolve here (unknown callsign -> 404, malformed -> 400) and should
     * fall back to OpenSkyFlightsClient.
     */
    public Optional<Route> fetchRoute(String callsign) {
        return lookupRoute(callsign).route();
    }

    /** Outcome of a callsign lookup — a miss is cacheable, a failure isn't. */
    public enum LookupStatus { FOUND, NOT_FOUND, THROTTLED, FAILED }

    public record RouteLookup(LookupStatus status, Optional<Route> route) {
        static RouteLookup of(LookupStatus status) {
            return new RouteLookup(status, Optional.empty());
        }
    }

    /**
     * Same lookup as fetchRoute, but says *why* nothing came back:
     * NOT_FOUND (adsbdb answered and doesn't know this callsign — 404/400,
     * or a record with no airports) is a real answer worth caching;
     * THROTTLED (429) and FAILED (anything else) are not, and tell a bulk
     * caller like CallsignRouteService to back off rather than record a
     * miss.
     */
    public RouteLookup lookupRoute(String callsign) {
        try {
            AdsbdbCallsignResponse body = client.get()
                    .uri("/callsign/{callsign}", callsign)
                    .retrieve()
                    .body(AdsbdbCallsignResponse.class);

            if (body == null || body.response() == null || body.response().flightroute() == null) {
                return RouteLookup.of(LookupStatus.NOT_FOUND);
            }
            FlightRoute route = body.response().flightroute();
            if (route.origin() == null && route.destination() == null) {
                return RouteLookup.of(LookupStatus.NOT_FOUND);
            }
            String origin = route.origin() == null ? null : route.origin().icao_code();
            String originName = route.origin() == null ? null : route.origin().name();
            Double originLat = route.origin() == null ? null : route.origin().latitude();
            Double originLon = route.origin() == null ? null : route.origin().longitude();
            String destination = route.destination() == null ? null : route.destination().icao_code();
            String destinationName = route.destination() == null ? null : route.destination().name();
            Double destinationLat = route.destination() == null ? null : route.destination().latitude();
            Double destinationLon = route.destination() == null ? null : route.destination().longitude();
            return new RouteLookup(LookupStatus.FOUND, Optional.of(new Route(origin, originName, originLat, originLon,
                    destination, destinationName, destinationLat, destinationLon)));
        } catch (HttpClientErrorException.TooManyRequests e) {
            return RouteLookup.of(LookupStatus.THROTTLED);
        } catch (HttpClientErrorException e) {
            // 404 unknown callsign, 400 malformed one — both a definite "no".
            return RouteLookup.of(LookupStatus.NOT_FOUND);
        } catch (Exception e) {
            log.debug("adsbdb callsign lookup failed for {}: {}", callsign, e.toString());
            return RouteLookup.of(LookupStatus.FAILED);
        }
    }

    public Optional<AircraftInfo> fetchAircraftInfo(String icao24) {
        try {
            AdsbdbAircraftResponse body = client.get()
                    .uri("/aircraft/{icao24}", icao24)
                    .retrieve()
                    .body(AdsbdbAircraftResponse.class);

            if (body == null || body.response() == null || body.response().aircraft() == null) {
                return Optional.empty();
            }
            Aircraft a = body.response().aircraft();
            String model = a.manufacturer() != null && a.type() != null
                    ? a.manufacturer() + " " + a.type()
                    : a.type();
            if (model == null && a.registration() == null && a.registered_owner() == null) {
                return Optional.empty();
            }
            return Optional.of(new AircraftInfo(model, a.registration(), a.registered_owner()));
        } catch (HttpClientErrorException.NotFound e) {
            return Optional.empty();
        } catch (Exception e) {
            log.debug("adsbdb aircraft lookup failed for {}: {}", icao24, e.toString());
            return Optional.empty();
        }
    }

    private record AdsbdbAircraftResponse(AdsbdbResponseBody response) {
    }

    private record AdsbdbResponseBody(Aircraft aircraft) {
    }

    // Field names match adsbdb's JSON keys directly (snake_case, no
    // camelCase conversion configured on the shared ObjectMapper).
    private record Aircraft(String type, String manufacturer, String registration, String registered_owner) {
    }

    private record AdsbdbCallsignResponse(AdsbdbCallsignBody response) {
    }

    private record AdsbdbCallsignBody(FlightRoute flightroute) {
    }

    private record FlightRoute(String callsign, Airport origin, Airport destination) {
    }

    // latitude/longitude were already present in adsbdb's response — just
    // never parsed out before (nothing used them until ETA needed them —
    // see AircraftController). Field names match adsbdb's JSON keys as-is,
    // same as Aircraft above.
    private record Airport(String icao_code, String name, Double latitude, Double longitude) {
    }
}
