package com.flighttracker.service.enrichment;

import com.flighttracker.service.agent.PollBackoff;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.ParameterizedTypeReference;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.client.HttpClientErrorException;
import org.springframework.web.client.RestClient;

import java.time.Duration;
import java.time.Instant;
import java.util.Comparator;
import java.util.List;
import java.util.Optional;

/**
 * Two lookups against OpenSky's /flights/aircraft endpoint, both keyed off
 * the same underlying historical-flights fetch (see fetchFlights):
 * origin/destination for an aircraft's most recent leg (fetchRoute), and
 * whether that leg has actually landed (confirmLanded). Unlike /states/all
 * (what OpenSkyAgent polls), this endpoint is authenticated-only —
 * anonymous requests get a 403 "You cannot access historical flights" — so
 * it goes through {@link OpenSkyOAuthTokenProvider}. If no OAuth app is
 * configured, or the lookup fails for any reason, both methods degrade to
 * an empty result rather than failing the caller: this is enrichment, not
 * core data.
 *
 * This is called concurrently from AircraftEnrichmentService's @Async pool
 * (see AsyncConfig) and from an "api"-container request thread
 * (AircraftController's on-demand enrichment/landing-check), unlike
 * OpenSkyAgent's single-threaded poll() — so unlike PollBackoff's usual
 * single-thread assumption, every access here is synchronized on the
 * backoff instance itself. No @Profile restriction: the "api" and "agent"
 * containers each get their own instance (and therefore their own
 * independent backoff state) since they're separate processes.
 *
 * PollBackoff alone is purely reactive — it only slows down *after*
 * OpenSky has already said no. In production this endpoint was hitting
 * 429s repeatedly (30s/60s/120s escalating backoffs, recurring): the
 * enrichment pool's 2 workers (see AsyncConfig) can both land on this
 * endpoint within the same instant, and the "api" container's on-demand
 * enrichment/landing-check adds a third, completely independent source of
 * calls with no coordination between any of them. MIN_CALL_INTERVAL below
 * is a proactive pace limit on top of that reactive backoff — capping how
 * often *this instance* will even attempt a call, regardless of demand —
 * specifically to reduce how often we trip the reactive backoff (or worse,
 * risk a harsher account-level penalty) in the first place, not to replace
 * it. A skipped-for-pacing call intentionally doesn't touch backoff at all:
 * it's not a failure, just this instance deliberately not asking yet.
 */
@Component
public class OpenSkyFlightsClient {

    private static final Logger log = LoggerFactory.getLogger(OpenSkyFlightsClient.class);
    private static final Duration LOOKBACK = Duration.ofHours(24);
    private static final Duration MIN_BACKOFF = Duration.ofSeconds(30);
    private static final Duration MAX_BACKOFF = Duration.ofMinutes(5);

    // Per-process cap of one real call every 15s to this endpoint,
    // regardless of how many callers want one at once — route lookups and
    // landing checks are both enrichment, not core data (see class javadoc),
    // so a caller waiting an extra few seconds is imperceptible; OpenSky
    // getting hammered by concurrent/rapid-fire requests to its historical-
    // flights endpoint isn't worth that trade. Two independent processes
    // (api + agent) each enforcing this independently means the real
    // combined worst case is double this — accepted the same way this
    // class's backoff state is already independent per process; a shared
    // cross-process limit would need DB-backed coordination (like
    // PollWindowService's hot-poll budget) for a comparatively minor,
    // already-gracefully-degrading endpoint. Revisit if 429s persist even
    // at this pace.
    private static final Duration MIN_CALL_INTERVAL = Duration.ofSeconds(15);

    private final RestClient client;
    private final String baseUrl;
    private final OpenSkyOAuthTokenProvider tokenProvider;
    private final PollBackoff backoff = new PollBackoff();
    // Guarded by synchronized (backoff) below, same lock as the backoff
    // state itself — one lock for everything this method needs to check
    // and update atomically before deciding whether to actually call out.
    private Instant lastCallAttemptAt = Instant.EPOCH;

    public OpenSkyFlightsClient(
            @Value("${flighttracker.agents.opensky.base-url}") String baseUrl,
            OpenSkyOAuthTokenProvider tokenProvider) {
        this.baseUrl = baseUrl;
        this.tokenProvider = tokenProvider;

        SimpleClientHttpRequestFactory requestFactory = new SimpleClientHttpRequestFactory();
        requestFactory.setConnectTimeout(5_000);
        requestFactory.setReadTimeout(10_000);
        this.client = RestClient.builder().requestFactory(requestFactory).build();
    }

    public Optional<Route> fetchRoute(String icao24) {
        List<OpenSkyFlight> flights = fetchFlights(icao24);
        if (flights.isEmpty()) return Optional.empty();

        OpenSkyFlight latest = flights.stream()
                .max(Comparator.comparingLong(f -> f.lastSeen() == null ? 0 : f.lastSeen()))
                .orElse(null);
        if (latest == null) return Optional.empty();
        if (latest.estDepartureAirport() == null && latest.estArrivalAirport() == null) return Optional.empty();

        return Optional.of(new Route(latest.estDepartureAirport(), null, null, null, latest.estArrivalAirport(), null, null, null));
    }

    /**
     * Confirms whether this aircraft's current leg — the one that produced
     * the report at {@code sinceObservedAt} — has actually ended at an
     * airport, rather than relying purely on our own silence+descending
     * heuristic (see LiveVisibilityWindows.PRESUMED_LANDED_SILENCE, the
     * only caller of this: AircraftEnrichmentService.checkLandingIfNeeded).
     * OpenSky computes each flight's boundaries from every contributing
     * receiver's full history, not just whatever our own poll cadence
     * happened to catch, so its lastSeen is a materially better signal
     * than "we personally stopped hearing from it" alone.
     *
     * @return the confirmed landing time (OpenSky's lastSeen) for the most
     *         recent flight record whose lastSeen is at or after
     *         sinceObservedAt and which has a known arrival airport; empty
     *         if there's no such record (no data yet, OpenSky unavailable,
     *         or genuinely still airborne).
     */
    public Optional<Instant> confirmLanded(String icao24, Instant sinceObservedAt) {
        List<OpenSkyFlight> flights = fetchFlights(icao24);
        return flights.stream()
                .filter(f -> f.lastSeen() != null && f.estArrivalAirport() != null)
                .map(f -> Instant.ofEpochSecond(f.lastSeen()))
                .filter(lastSeen -> !lastSeen.isBefore(sinceObservedAt))
                .max(Comparator.naturalOrder());
    }

    private List<OpenSkyFlight> fetchFlights(String icao24) {
        Optional<String> token = tokenProvider.getAccessToken();
        if (token.isEmpty()) return List.of();

        synchronized (backoff) {
            Instant now = Instant.now();
            if (backoff.isCoolingDown(now)) return List.of();
            if (Duration.between(lastCallAttemptAt, now).compareTo(MIN_CALL_INTERVAL) < 0) {
                return List.of();
            }
            lastCallAttemptAt = now;
        }

        long end = Instant.now().getEpochSecond();
        long begin = end - LOOKBACK.toSeconds();
        String url = baseUrl + "/flights/aircraft?icao24=" + icao24 + "&begin=" + begin + "&end=" + end;

        try {
            List<OpenSkyFlight> flights = client.get()
                    .uri(url)
                    .header("Authorization", "Bearer " + token.get())
                    .retrieve()
                    .body(new ParameterizedTypeReference<List<OpenSkyFlight>>() { });

            synchronized (backoff) { backoff.recordSuccess(); }
            return flights == null ? List.of() : flights;
        } catch (HttpClientErrorException.TooManyRequests e) {
            Duration wait;
            synchronized (backoff) { wait = backoff.recordFailure(MIN_BACKOFF, MAX_BACKOFF); }
            log.warn("OpenSky flights lookup throttled (429) — backing off {}s", wait.toSeconds());
            return List.of();
        } catch (Exception e) {
            synchronized (backoff) { backoff.recordFailure(MIN_BACKOFF, MAX_BACKOFF); }
            log.warn("OpenSky flights lookup failed for {}: {}", icao24, e.toString());
            return List.of();
        }
    }

    private record OpenSkyFlight(String icao24, Long lastSeen, String estDepartureAirport, String estArrivalAirport) {
    }
}
