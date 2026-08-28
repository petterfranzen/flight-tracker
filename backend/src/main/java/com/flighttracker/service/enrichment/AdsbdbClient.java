package com.flighttracker.service.enrichment;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
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
 * No @Profile restriction: used by the "agent" container's eager
 * enrichment of newly hot-polled aircraft, and by the "api" container's
 * on-demand enrichment (AircraftController) for aircraft the global sweep
 * found but nobody's looked at yet.
 */
@Component
public class AdsbdbClient {

    private static final Logger log = LoggerFactory.getLogger(AdsbdbClient.class);

    private final RestClient client;

    public AdsbdbClient() {
        SimpleClientHttpRequestFactory requestFactory = new SimpleClientHttpRequestFactory();
        requestFactory.setConnectTimeout(5_000);
        requestFactory.setReadTimeout(10_000);
        this.client = RestClient.builder()
                .baseUrl("https://api.adsbdb.com/v0")
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
        try {
            AdsbdbCallsignResponse body = client.get()
                    .uri("/callsign/{callsign}", callsign)
                    .retrieve()
                    .body(AdsbdbCallsignResponse.class);

            if (body == null || body.response() == null || body.response().flightroute() == null) {
                return Optional.empty();
            }
            FlightRoute route = body.response().flightroute();
            if (route.origin() == null && route.destination() == null) {
                return Optional.empty();
            }
            String origin = route.origin() == null ? null : route.origin().icao_code();
            String originName = route.origin() == null ? null : route.origin().name();
            String destination = route.destination() == null ? null : route.destination().icao_code();
            String destinationName = route.destination() == null ? null : route.destination().name();
            return Optional.of(new Route(origin, originName, destination, destinationName));
        } catch (HttpClientErrorException e) {
            return Optional.empty();
        } catch (Exception e) {
            log.debug("adsbdb callsign lookup failed for {}: {}", callsign, e.toString());
            return Optional.empty();
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

    private record Airport(String icao_code, String name) {
    }
}
