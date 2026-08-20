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
}
