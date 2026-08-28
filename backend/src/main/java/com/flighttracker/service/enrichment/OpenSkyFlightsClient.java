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
 * Looks up origin/destination for an aircraft's most recent flight leg via
 * OpenSky's /flights/aircraft endpoint. Unlike /states/all (what
 * OpenSkyAgent polls), this one is authenticated-only — anonymous requests
 * get a 403 "You cannot access historical flights" — so it goes through
 * {@link OpenSkyOAuthTokenProvider}. If no OAuth app is configured, or the
 * lookup fails for any reason, this degrades to an empty result rather than
 * failing the caller: origin/destination is enrichment, not core data.
 *
 * This is called concurrently from AircraftEnrichmentService's @Async pool
 * (see AsyncConfig) and from an "api"-container request thread
 * (AircraftController's on-demand enrichment), unlike OpenSkyAgent's
 * single-threaded poll() — so unlike PollBackoff's usual single-thread
 * assumption, every access here is synchronized on the backoff instance
 * itself. No @Profile restriction: the "api" and "agent" containers each
 * get their own instance (and therefore their own independent backoff
 * state) since they're separate processes.
 */
@Component
public class OpenSkyFlightsClient {

    private static final Logger log = LoggerFactory.getLogger(OpenSkyFlightsClient.class);
    private static final Duration LOOKBACK = Duration.ofHours(24);
    private static final Duration MIN_BACKOFF = Duration.ofSeconds(30);
    private static final Duration MAX_BACKOFF = Duration.ofMinutes(5);

    private final RestClient client;
    private final String baseUrl;
    private final OpenSkyOAuthTokenProvider tokenProvider;
    private final PollBackoff backoff = new PollBackoff();

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
        Optional<String> token = tokenProvider.getAccessToken();
        if (token.isEmpty()) return Optional.empty();

        synchronized (backoff) {
            if (backoff.isCoolingDown(Instant.now())) return Optional.empty();
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

            if (flights == null || flights.isEmpty()) return Optional.empty();

            OpenSkyFlight latest = flights.stream()
                    .max(Comparator.comparingLong(f -> f.lastSeen() == null ? 0 : f.lastSeen()))
                    .orElse(null);
            if (latest == null) return Optional.empty();
            if (latest.estDepartureAirport() == null && latest.estArrivalAirport() == null) return Optional.empty();

            return Optional.of(new Route(latest.estDepartureAirport(), null, latest.estArrivalAirport(), null));
        } catch (HttpClientErrorException.TooManyRequests e) {
            Duration wait;
            synchronized (backoff) { wait = backoff.recordFailure(MIN_BACKOFF, MAX_BACKOFF); }
            log.warn("OpenSky flights lookup throttled (429) — backing off {}s", wait.toSeconds());
            return Optional.empty();
        } catch (Exception e) {
            synchronized (backoff) { backoff.recordFailure(MIN_BACKOFF, MAX_BACKOFF); }
            log.warn("OpenSky flights lookup failed for {}: {}", icao24, e.toString());
            return Optional.empty();
        }
    }

    private record OpenSkyFlight(String icao24, Long lastSeen, String estDepartureAirport, String estArrivalAirport) {
    }
}
