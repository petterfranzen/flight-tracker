package com.flighttracker.service.agent;

import com.flighttracker.dto.Bounds;
import com.flighttracker.service.ViewportService;
import com.flighttracker.service.enrichment.OpenSkyOAuthTokenProvider;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpHeaders;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.context.annotation.Profile;
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
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Polls OpenSky Network's free REST endpoint for state vectors. Anonymous
 * access is rate-limited per source IP (roughly one request per 10s, plus a
 * daily credit budget shared by everyone behind that IP — e.g. a dev machine
 * and a home-NAS deployment sharing one router). When
 * {@code OPENSKY_CLIENT_ID}/{@code OPENSKY_CLIENT_SECRET} are configured
 * (see {@link OpenSkyOAuthTokenProvider}, otherwise only used for dossier
 * enrichment), every request here is sent with that account's bearer token
 * instead — a separate, much larger budget that doesn't compete with the
 * anonymous one. Falls back to anonymous automatically if no credentials
 * are configured.
 * Docs: https://openskynetwork.github.io/opensky-api/rest.html
 *
 * Two distinct poll shapes share this one class (and its RestClient/
 * backoff — they hit the same account, so a 429 from one must back off the
 * other too):
 *  - poll(): the frequent, poll-window-gated "hot" poll, scoped to
 *    whatever bounding box ViewportService currently reports — i.e.
 *    whatever's actually on someone's screen right now.
 *  - pollGlobal(): AgentOrchestrator's always-on sweep (every
 *    global-sweep-interval-seconds, regardless of the poll window),
 *    unbounded — every aircraft OpenSky reports worldwide.
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
@Profile("agent")
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

    // A viewport this large (e.g. someone zoomed out to see the whole
    // world) isn't "hot polling a region" any more — it's a second global
    // sweep, just running 20x more often (every poll-interval-seconds
    // instead of every global-sweep-interval-seconds). That's exactly the
    // scenario that exhausted a real account's daily credit budget in
    // testing: OpenSky started returning a tiny handful of aircraft per
    // call instead of an error, so it looked like traffic had vanished
    // rather than like a quota problem. 10,000 sq-degrees is generous —
    // roughly a 100x100 box, continent-scale — comfortably above any
    // normal "zoomed into a region" viewport. Above it, skip the hot poll
    // for this cycle; the always-on global sweep still covers the area,
    // just on its own slower schedule.
    private static final double MAX_HOT_POLL_AREA_SQ_DEG = 10_000;

    private final RestClient client;
    private final String statesUrl;
    private final boolean enabled;
    private final ViewportService viewportService;
    private final OpenSkyOAuthTokenProvider tokenProvider;
    private final PollBackoff backoff = new PollBackoff();
    // Logged once, not every poll cycle — so "why are we getting 429s" is
    // answerable from the logs immediately instead of requiring a debugging
    // session to discover polling was running anonymous the whole time.
    private final AtomicBoolean authModeLogged = new AtomicBoolean(false);

    public OpenSkyAgent(
            @Value("${flighttracker.agents.opensky.enabled:true}") boolean enabled,
            @Value("${flighttracker.agents.opensky.base-url}") String baseUrl,
            ViewportService viewportService,
            OpenSkyOAuthTokenProvider tokenProvider) {
        this.enabled = enabled;
        this.viewportService = viewportService;
        this.tokenProvider = tokenProvider;

        SimpleClientHttpRequestFactory requestFactory = new SimpleClientHttpRequestFactory();
        requestFactory.setConnectTimeout((int) CONNECT_TIMEOUT.toMillis());
        requestFactory.setReadTimeout((int) READ_TIMEOUT.toMillis());
        this.client = RestClient.builder().requestFactory(requestFactory).build();

        this.statesUrl = baseUrl + "/states/all";
    }

    @Override
    public String sourceName() {
        return "opensky";
    }

    /** Hot poll: whatever's currently on someone's screen (see ViewportService). */
    @Override
    public List<RawPositionReport> poll() {
        if (!enabled) return List.of();
        Bounds b = viewportService.current();
        double area = (b.latMax() - b.latMin()) * (b.lonMax() - b.lonMin());
        if (area > MAX_HOT_POLL_AREA_SQ_DEG) {
            log.debug("Viewport too large for the hot poll ({} sq-deg > {}) — relying on the global sweep this cycle", area, MAX_HOT_POLL_AREA_SQ_DEG);
            return List.of();
        }
        String url = statesUrl + "?lamin=" + b.latMin() + "&lamax=" + b.latMax()
                + "&lomin=" + b.lonMin() + "&lomax=" + b.lonMax();
        return fetchStates(url);
    }

    /** Global sweep: every aircraft OpenSky currently reports, worldwide — no bbox. */
    @Override
    public List<RawPositionReport> pollGlobal() {
        if (!enabled) return List.of();
        return fetchStates(statesUrl);
    }

    @SuppressWarnings("unchecked")
    private List<RawPositionReport> fetchStates(String url) {
        Instant now = Instant.now();
        if (backoff.isCoolingDown(now)) {
            log.debug("Skipping poll, backing off until {}", backoff.coolingDownUntil());
            return List.of();
        }

        try {
            RestClient.RequestHeadersSpec<?> request = client.get().uri(url);
            Optional<String> token = tokenProvider.getAccessToken();
            if (token.isPresent()) {
                request = request.header(HttpHeaders.AUTHORIZATION, "Bearer " + token.get());
            }
            if (authModeLogged.compareAndSet(false, true)) {
                log.info("OpenSky polling is {}", token.isPresent() ? "authenticated" : "anonymous (no OPENSKY_CLIENT_ID/SECRET configured)");
            }
            Map<String, Object> body = request.retrieve().body(Map.class);
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
            // failure mode can't hot-loop the poller every 18s either.
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
