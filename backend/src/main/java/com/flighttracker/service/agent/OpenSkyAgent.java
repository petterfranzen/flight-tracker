package com.flighttracker.service.agent;

import com.flighttracker.dto.Bounds;
import com.flighttracker.observability.PhaseLogger;
import com.flighttracker.service.ViewportService;
import com.flighttracker.service.enrichment.OpenSkyOAuthTokenProvider;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpHeaders;
import org.springframework.http.ResponseEntity;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.client.HttpClientErrorException;
import org.springframework.web.client.HttpServerErrorException;
import org.springframework.web.client.ResourceAccessException;
import org.springframework.web.client.RestClient;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
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
 * Two distinct poll shapes share this one class, but not one cooldown:
 *  - poll(): the frequent, poll-window-gated "hot" poll, scoped to
 *    whatever bounding box ViewportService currently reports — i.e.
 *    whatever's actually on someone's screen right now.
 *  - pollGlobal(): AgentOrchestrator's always-on sweep (every
 *    global-sweep-interval-seconds, regardless of the poll window),
 *    unbounded — every aircraft OpenSky reports worldwide.
 *
 * The two shapes hit the same account, so the *credit budget* is shared —
 * {@link OpenSkyRateLimit} holds it, read from OpenSky's own headers. But
 * the *cooldowns* are separate ({@link PollBackoff} each), because they run
 * on wildly different cadences: a 429 on the 18s hot poll used to set one
 * shared backoff that then silently suppressed the next 360s global sweep
 * too. Now the frequent poll backs itself off, the sweep backs itself off,
 * and the credit budget is what stops either from spending credits the
 * remaining sweeps of the day need.
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

    // A full-world /states/all costs this much of OpenSky's per-account
    // daily credit budget (OpenSky's own docs). Used to reserve enough of
    // the budget for the sweeps still due before it resets.
    static final int CREDITS_PER_GLOBAL_SWEEP = 4;

    private final RestClient client;
    private final String statesUrl;
    private final boolean enabled;
    private final ViewportService viewportService;
    private final OpenSkyOAuthTokenProvider tokenProvider;
    private final PhaseLogger phases;
    private final Clock clock;
    private final long globalSweepIntervalSeconds;

    // One cooldown per poll shape (see the class javadoc). Deliberately not
    // shared: the hot poll runs 20x more often and must not be able to
    // silence the always-on sweep with its own backoff.
    private final PollBackoff hotBackoff = new PollBackoff();
    private final PollBackoff sweepBackoff = new PollBackoff();
    // Shared: one account, one credit budget, straight from OpenSky's headers.
    private final OpenSkyRateLimit rateLimit = new OpenSkyRateLimit();

    // Logged once, not every poll cycle — so "why are we getting 429s" is
    // answerable from the logs immediately instead of requiring a debugging
    // session to discover polling was running anonymous the whole time.
    private final AtomicBoolean authModeLogged = new AtomicBoolean(false);

    @Autowired
    public OpenSkyAgent(
            @Value("${flighttracker.agents.opensky.enabled:true}") boolean enabled,
            @Value("${flighttracker.agents.opensky.base-url}") String baseUrl,
            ViewportService viewportService,
            OpenSkyOAuthTokenProvider tokenProvider,
            PhaseLogger phases,
            Clock clock,
            @Value("${flighttracker.agents.global-sweep-interval-seconds:360}") long globalSweepIntervalSeconds) {
        this(enabled, baseUrl, viewportService, tokenProvider, phases, clock, globalSweepIntervalSeconds, defaultBuilder());
    }

    /** For tests: a builder that may already be bound to a mock server. */
    OpenSkyAgent(boolean enabled,
                 String baseUrl,
                 ViewportService viewportService,
                 OpenSkyOAuthTokenProvider tokenProvider,
                 PhaseLogger phases,
                 Clock clock,
                 long globalSweepIntervalSeconds,
                 RestClient.Builder builder) {
        this.enabled = enabled;
        this.viewportService = viewportService;
        this.tokenProvider = tokenProvider;
        this.phases = phases;
        this.clock = clock;
        this.globalSweepIntervalSeconds = globalSweepIntervalSeconds;
        this.client = builder.build();
        this.statesUrl = baseUrl + "/states/all";
    }

    private static RestClient.Builder defaultBuilder() {
        SimpleClientHttpRequestFactory requestFactory = new SimpleClientHttpRequestFactory();
        requestFactory.setConnectTimeout((int) CONNECT_TIMEOUT.toMillis());
        requestFactory.setReadTimeout((int) READ_TIMEOUT.toMillis());
        return RestClient.builder().requestFactory(requestFactory);
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
        if (creditsReservedForSweeps()) {
            // Spend what's left on the world-wide refresh, not on a
            // viewport that the sweep will cover anyway on its own slower
            // schedule — otherwise a busy hot poll starves the sweep of the
            // very credits it needs, and global freshness dies first.
            log.debug("Hot poll yielding: {} OpenSky credits left, reserving them for the sweeps still due today", rateLimit.remaining());
            return List.of();
        }
        String url = statesUrl + "?lamin=" + b.latMin() + "&lamax=" + b.latMax()
                + "&lomin=" + b.lonMin() + "&lomax=" + b.lonMax();
        return fetchStates(url, hotBackoff);
    }

    /** Global sweep: every aircraft OpenSky currently reports, worldwide — no bbox. */
    @Override
    public List<RawPositionReport> pollGlobal() {
        if (!enabled) return List.of();
        return fetchStates(statesUrl, sweepBackoff);
    }

    /**
     * True while the credits left in the account's daily budget wouldn't
     * cover the global sweeps still due before it resets, so the hot poll
     * should yield them. Only answers true once a header has actually told
     * us how many credits are left; with no header seen yet (an older
     * OpenSky, a fixture, a first-ever call) the hot poll runs as it always
     * did rather than guessing a budget.
     */
    private boolean creditsReservedForSweeps() {
        if (!rateLimit.known()) return false;
        long needed = sweepsDueToday(clock.instant(), globalSweepIntervalSeconds) * CREDITS_PER_GLOBAL_SWEEP;
        return rateLimit.remaining() < needed;
    }

    /** How many fixed-interval sweeps still fit between {@code now} and the next UTC midnight. */
    static long sweepsDueToday(Instant now, long intervalSeconds) {
        if (intervalSeconds <= 0) return 0;
        Instant midnight = now.atZone(ZoneOffset.UTC).toLocalDate().plusDays(1).atStartOfDay(ZoneOffset.UTC).toInstant();
        long secondsLeft = Math.max(0, Duration.between(now, midnight).toSeconds());
        return (secondsLeft + intervalSeconds - 1) / intervalSeconds; // ceil, so a partial interval still counts
    }

    @SuppressWarnings("unchecked")
    private List<RawPositionReport> fetchStates(String url, PollBackoff backoff) {
        Instant now = clock.instant();
        if (backoff.isCoolingDown(now)) {
            log.debug("Skipping poll, backing off until {}", backoff.coolingDownUntil());
            return List.of();
        }
        if (rateLimit.exhausted(now)) {
            // OpenSky's own headers said the budget is spent; don't spend a
            // call confirming it. Cool down exactly until the reset it
            // advertised (self-correcting as the reset approaches).
            Duration wait = rateLimit.waitUntilReset(now).orElse(MIN_BACKOFF);
            backoff.recordFailure(wait);
            log.warn("OpenSky credit budget exhausted — backing off {}s", wait.toSeconds());
            phases.degraded("OpenSky credit budget exhausted, backing off " + wait.toSeconds() + "s");
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
            ResponseEntity<Map> response = request.retrieve().toEntity(Map.class);
            rateLimit.observe(response.getHeaders(), clock.instant());
            backoff.recordSuccess();
            Map<String, Object> body = response.getBody();
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
                        altitudeM(s),
                        asDouble(s.get(9)),   // velocity, m/s
                        asDouble(s.get(10)),  // true track, deg
                        asDouble(s.get(11)),  // vertical rate, m/s
                        Boolean.TRUE.equals(s.get(8)) // on_ground
                ));
            }
            return out;
        } catch (HttpClientErrorException.TooManyRequests e) {
            rateLimit.observe(e.getResponseHeaders(), clock.instant());
            Optional<Duration> retryAfter = retryAfter(e);
            Duration wait;
            if (retryAfter.isPresent()) {
                wait = retryAfter.get();
                backoff.recordFailure(wait); // still count toward escalation, even though the wait itself is server-dictated
            } else {
                wait = backoff.recordFailure(MIN_BACKOFF, MAX_BACKOFF);
            }
            log.warn("OpenSky throttled us (429) — backing off {}s", wait.toSeconds());
            // Surfaces on the dashboard as "Degraded" rather than the
            // stack merely looking quiet: being rate-limited by the
            // upstream is the single most common reason a demo shows
            // fewer aircraft than expected.
            phases.degraded("OpenSky rate-limited us (429), backing off " + wait.toSeconds() + "s");
            return List.of();
        } catch (HttpServerErrorException e) {
            // The API itself is unhealthy, not just rate-limiting us — back
            // off substantially harder than a transient timeout so we're
            // not adding load to an upstream that's already failing.
            rateLimit.observe(e.getResponseHeaders(), clock.instant());
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

    /**
     * OpenSky's wait hint, preferring its own header
     * ({@code X-Rate-Limit-Retry-After-Seconds}) over the standard
     * {@code Retry-After} — the one it actually sends. An unparseable value
     * (or an HTTP-date Retry-After) just falls back to our own backoff.
     */
    private static Optional<Duration> retryAfter(HttpClientErrorException.TooManyRequests e) {
        HttpHeaders headers = e.getResponseHeaders();
        Long seconds = OpenSkyRateLimit.longHeader(headers, OpenSkyRateLimit.RETRY_AFTER_HEADER);
        if (seconds == null) seconds = OpenSkyRateLimit.longHeader(headers, OpenSkyRateLimit.RETRY_AFTER_HTTP_HEADER);
        return seconds == null ? Optional.empty() : Optional.of(Duration.ofSeconds(seconds));
    }

    /**
     * Geometric (GPS) altitude where the aircraft reports one, barometric
     * otherwise. Barometric is pressure altitude against the standard
     * atmosphere: on a high-pressure day it reads tens of metres below
     * ground near sea level (DFL5800 at -23 m, SEKHU at -46 m).
     */
    static Double altitudeM(List<Object> state) {
        Double geometric = state.size() > 13 ? asDouble(state.get(13)) : null;
        return geometric != null ? geometric : asDouble(state.get(7));
    }

    private static Double asDouble(Object o) {
        return o instanceof Number n ? n.doubleValue() : null;
    }
}
