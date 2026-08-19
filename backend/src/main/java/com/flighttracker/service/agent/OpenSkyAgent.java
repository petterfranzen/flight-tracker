package com.flighttracker.service.agent;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.client.HttpClientErrorException;
import org.springframework.web.client.HttpServerErrorException;
import org.springframework.web.client.ResourceAccessException;
import org.springframework.web.client.RestClient;

import java.time.Instant;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * Polls OpenSky Network's free REST endpoint for state vectors in a bounding
 * box. Anonymous access is rate-limited (roughly one request per 10s, plus a
 * daily credit budget) — fine for a demo, register for a free account and
 * add basic auth via RestClient if you need tighter polling.
 * Docs: https://openskynetwork.github.io/opensky-api/rest.html
 *
 * Connect/read timeouts keep a hung request from stalling the single
 * scheduled-poll thread forever. On a 429 (throttled), a 5xx (the API
 * itself is unhealthy), a timeout, or any other unexpected failure, the
 * agent backs off — skipping the network call entirely — instead of
 * hammering an endpoint that's already telling us to slow down or is
 * outright down. A 5xx backs off harder and longer than a mere timeout:
 * a struggling upstream is exactly the wrong thing to keep hitting every
 * poll cycle. The backoff state machine itself lives in PollBackoff so a
 * future FlightDataAgent doesn't have to reimplement it.
 */
@Component
public class OpenSkyAgent implements FlightDataAgent {

    private static final Logger log = LoggerFactory.getLogger(OpenSkyAgent.class);

    private static final Duration CONNECT_TIMEOUT = Duration.ofSeconds(5);
    private static final Duration READ_TIMEOUT = Duration.ofSeconds(10);

    // Transient failures (timeouts, 429s without a Retry-After, and any
    // other unexpected error): back off quickly but not too aggressively.
    private static final Duration MIN_BACKOFF = Duration.ofSeconds(30);
    private static final Duration MAX_BACKOFF = Duration.ofMinutes(5);

    // The API itself is erroring (5xx): it needs room to recover, so start
    // higher and cap higher than a transient failure would.
    private static final Duration SEVERE_MIN_BACKOFF = Duration.ofMinutes(2);
    private static final Duration SEVERE_MAX_BACKOFF = Duration.ofMinutes(10);

    private final RestClient client;
    private final String url;
    private final boolean enabled;
    private final PollBackoff backoff = new PollBackoff();

    public OpenSkyAgent(
            @Value("${flighttracker.agents.opensky.enabled:true}") boolean enabled,
            @Value("${flighttracker.agents.opensky.base-url}") String baseUrl,
            @Value("${flighttracker.agents.opensky.bbox.lat-min}") double latMin,
            @Value("${flighttracker.agents.opensky.bbox.lat-max}") double latMax,
            @Value("${flighttracker.agents.opensky.bbox.lon-min}") double lonMin,
            @Value("${flighttracker.agents.opensky.bbox.lon-max}") double lonMax) {
        this.enabled = enabled;

        SimpleClientHttpRequestFactory requestFactory = new SimpleClientHttpRequestFactory();
        requestFactory.setConnectTimeout((int) CONNECT_TIMEOUT.toMillis());
        requestFactory.setReadTimeout((int) READ_TIMEOUT.toMillis());
        this.client = RestClient.builder().requestFactory(requestFactory).build();

        this.url = baseUrl + "/states/all?lamin=" + latMin + "&lamax=" + latMax
                + "&lomin=" + lonMin + "&lomax=" + lonMax;
    }

    @Override
    public String sourceName() {
        return "opensky";
    }

    @Override
    @SuppressWarnings("unchecked")
    public List<RawPositionReport> poll() {
        if (!enabled) return List.of();

        Instant now = Instant.now();
        if (backoff.isCoolingDown(now)) {
            log.debug("Skipping poll, backing off until {}", backoff.coolingDownUntil());
            return List.of();
        }

        try {
            Map<String, Object> body = client.get().uri(url).retrieve().body(Map.class);
            backoff.recordSuccess();
            if (body == null || body.get("states") == null) return List.of();

            List<List<Object>> states = (List<List<Object>>) body.get("states");
            List<RawPositionReport> out = new ArrayList<>();
            for (List<Object> s : states) {
                // OpenSky state vector array layout — index 5/6 = lon/lat.
                Double lon = asDouble(s.get(5));
                Double lat = asDouble(s.get(6));
                if (lon == null || lat == null) continue; // no fix yet, skip

                out.add(new RawPositionReport(
                        ((String) s.get(0)).trim(),                 // icao24
                        s.get(1) == null ? null : ((String) s.get(1)).trim(), // callsign
                        Instant.ofEpochSecond(((Number) s.get(4)).longValue()),
                        lat, lon,
                        asDouble(s.get(7)),   // baro altitude, m
                        asDouble(s.get(9)),   // velocity, m/s
                        asDouble(s.get(10)),  // true track, deg
                        asDouble(s.get(11)),  // vertical rate, m/s
                        Boolean.TRUE.equals(s.get(8)) // on_ground
                ));
            }
            return out;
        } catch (HttpClientErrorException.TooManyRequests e) {
            Optional<Duration> retryAfter = retryAfter(e);
            Duration wait;
            if (retryAfter.isPresent()) {
                wait = retryAfter.get();
                backoff.recordFailure(wait); // still count toward escalation, even though the wait itself is server-dictated
            } else {
                wait = backoff.recordFailure(MIN_BACKOFF, MAX_BACKOFF);
            }
            log.warn("OpenSky throttled us (429) — backing off {}s", wait.toSeconds());
            return List.of();
        } catch (HttpServerErrorException e) {
            // The API itself is unhealthy, not just rate-limiting us — back
            // off substantially harder than a transient timeout so we're
            // not adding load to an upstream that's already failing.
            Duration wait = backoff.recordFailure(SEVERE_MIN_BACKOFF, SEVERE_MAX_BACKOFF);
            log.warn("OpenSky returned a server error ({}) — backing off {}s", e.getStatusCode(), wait.toSeconds());
            return List.of();
        } catch (ResourceAccessException e) {
            // Connect/read timeout, DNS failure, connection reset, etc.
            Duration wait = backoff.recordFailure(MIN_BACKOFF, MAX_BACKOFF);
            log.warn("OpenSky request timed out ({}) — backing off {}s", e.getMessage(), wait.toSeconds());
            return List.of();
        } catch (Exception e) {
            // Anything else unexpected: still back off, so an unforeseen
            // failure mode can't hot-loop the poller every 15s either.
            Duration wait = backoff.recordFailure(MIN_BACKOFF, MAX_BACKOFF);
            log.warn("OpenSky poll failed ({}) — backing off {}s", e.toString(), wait.toSeconds());
            return List.of();
        }
    }

    private Optional<Duration> retryAfter(HttpClientErrorException.TooManyRequests e) {
        String header = e.getResponseHeaders() == null ? null : e.getResponseHeaders().getFirst("Retry-After");
        if (header == null) return Optional.empty();
        try {
            return Optional.of(Duration.ofSeconds(Long.parseLong(header.trim())));
        } catch (NumberFormatException ex) {
            return Optional.empty(); // Retry-After can also be an HTTP-date; we just fall back to our own backoff
        }
    }

    private static Double asDouble(Object o) {
        return o instanceof Number n ? n.doubleValue() : null;
    }
}
