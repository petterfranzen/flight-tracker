package com.flighttracker.service.enrichment;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.util.LinkedMultiValueMap;
import org.springframework.util.MultiValueMap;
import org.springframework.web.client.RestClient;

import java.time.Duration;
import java.time.Instant;
import java.util.Optional;

/**
 * Exchanges the OpenSky client-credentials app for a bearer token, used by
 * {@link OpenSkyFlightsClient} to call the authenticated /flights/aircraft
 * endpoint (anonymous access to it returns 403 — unlike /states/all, which
 * still works anonymously and is what {@code OpenSkyAgent} polls).
 *
 * Tokens expire every 30 minutes; this caches the token and refreshes it a
 * minute early rather than on every call, so a burst of dossier lookups
 * doesn't turn into a burst of token requests. No @Profile restriction —
 * the "api" container needs this too, for AircraftController's on-demand
 * enrichment.
 */
@Component
public class OpenSkyOAuthTokenProvider {

    private static final Logger log = LoggerFactory.getLogger(OpenSkyOAuthTokenProvider.class);
    private static final Duration EARLY_REFRESH = Duration.ofSeconds(60);

    private final RestClient client;
    private final String tokenUrl;
    private final String clientId;
    private final String clientSecret;

    private volatile String cachedToken;
    private volatile Instant expiresAt = Instant.EPOCH;

    public OpenSkyOAuthTokenProvider(
            @Value("${flighttracker.agents.opensky.oauth.token-url}") String tokenUrl,
            @Value("${flighttracker.agents.opensky.oauth.client-id}") String clientId,
            @Value("${flighttracker.agents.opensky.oauth.client-secret}") String clientSecret) {
        this.tokenUrl = tokenUrl;
        this.clientId = clientId;
        this.clientSecret = clientSecret;
        this.client = RestClient.create();
    }

    /** Empty if no client-id/secret is configured, or the token request fails. */
    public synchronized Optional<String> getAccessToken() {
        if (clientId == null || clientId.isBlank() || clientSecret == null || clientSecret.isBlank()) {
            return Optional.empty();
        }
        if (cachedToken != null && Instant.now().isBefore(expiresAt)) {
            return Optional.of(cachedToken);
        }
        try {
            MultiValueMap<String, String> form = new LinkedMultiValueMap<>();
            form.add("grant_type", "client_credentials");
            form.add("client_id", clientId);
            form.add("client_secret", clientSecret);

            TokenResponse response = client.post()
                    .uri(tokenUrl)
                    .contentType(MediaType.APPLICATION_FORM_URLENCODED)
                    .body(form)
                    .retrieve()
                    .body(TokenResponse.class);

            if (response == null || response.access_token() == null) {
                log.warn("OpenSky token response had no access_token");
                return Optional.empty();
            }
            cachedToken = response.access_token();
            long ttl = response.expires_in() == null ? 0 : response.expires_in();
            expiresAt = Instant.now().plusSeconds(Math.max(30, ttl - EARLY_REFRESH.toSeconds()));
            return Optional.of(cachedToken);
        } catch (Exception e) {
            log.warn("Failed to obtain OpenSky OAuth token: {}", e.toString());
            return Optional.empty();
        }
    }

    // Field names match the token endpoint's JSON keys directly (Jackson
    // doesn't snake_case-to-camelCase by default without extra config).
    private record TokenResponse(String access_token, Integer expires_in) {
    }
}
