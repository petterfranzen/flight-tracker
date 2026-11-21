package com.flighttracker.config;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.security.oauth2.client.web.AuthorizationRequestRepository;
import org.springframework.security.oauth2.core.endpoint.OAuth2AuthorizationRequest;
import org.springframework.security.oauth2.core.endpoint.OAuth2ParameterNames;

import java.time.Clock;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Keeps a pending OAuth authorization request out of the HTTP session
 * (security: section9-hq #404, H3).
 *
 * <p>Spring's default {@code HttpSessionOAuth2AuthorizationRequestRepository}
 * writes the authorization request into the session, so a bare
 * {@code GET /oauth2/authorization/*} creates one. Sessions here idle for 24h
 * and there is no cap, so a client that only ever starts the flow grows the
 * heap by one session per call. This repository holds the request in a small,
 * TTL-bounded, in-memory map keyed by its {@code state} instead, so starting a
 * login creates no session at all — a session appears only once a login
 * actually succeeds.
 *
 * <p>Bounded on purpose: the map holds at most {@link #MAX_PENDING} entries and
 * an entry older than {@link #TTL} is dropped, so the store cannot grow without
 * limit however many starts arrive. An evicted or expired request costs the
 * client only a retry: the {@code state} it sends back no longer resolves, so
 * the login fails cleanly to the SPA's {@code /?error}. This is a single-process
 * app (one JVM behind the tunnel), so nothing needs the store to be shared.
 */
public class BoundedAuthorizationRequestRepository implements AuthorizationRequestRepository<OAuth2AuthorizationRequest> {

    /** Cap on pending requests; the least-recently-used is evicted past this. */
    static final int MAX_PENDING = 1_000;

    /** A pending request older than this is dead; the login it belongs to has long since failed. */
    static final Duration TTL = Duration.ofMinutes(10);

    private final Clock clock;
    private final Map<String, Pending> pending = new LinkedHashMap<>(16, 0.75f, true) {
        @Override
        protected boolean removeEldestEntry(Map.Entry<String, Pending> eldest) {
            return size() > MAX_PENDING;
        }
    };

    public BoundedAuthorizationRequestRepository() {
        this(Clock.systemUTC());
    }

    BoundedAuthorizationRequestRepository(Clock clock) {
        this.clock = clock;
    }

    /** The request a callback with this {@code state} started, without consuming it. */
    @Override
    public synchronized OAuth2AuthorizationRequest loadAuthorizationRequest(HttpServletRequest request) {
        String state = state(request);
        Pending entry = state == null ? null : pending.get(state);
        if (entry == null) {
            return null;
        }
        if (isExpired(entry)) {
            pending.remove(state);
            return null;
        }
        return entry.request();
    }

    /**
     * Records the request a redirect is about to send, or clears it when the
     * redirect is cancelled ({@code authorizationRequest} is {@code null}). A
     * request with no {@code state} is not stored: without one a later callback
     * cannot be matched to it, and the resolver always generates one.
     */
    @Override
    public synchronized void saveAuthorizationRequest(OAuth2AuthorizationRequest authorizationRequest,
            HttpServletRequest request, HttpServletResponse response) {
        String state = authorizationRequest == null ? state(request) : authorizationRequest.getState();
        if (state == null) {
            return;
        }
        if (authorizationRequest == null) {
            pending.remove(state);
        } else {
            pending.put(state, new Pending(authorizationRequest, clock.millis()));
        }
    }

    /** The request a callback with this {@code state} started, consumed once. */
    @Override
    public synchronized OAuth2AuthorizationRequest removeAuthorizationRequest(HttpServletRequest request,
            HttpServletResponse response) {
        String state = state(request);
        Pending entry = state == null ? null : pending.remove(state);
        return entry == null || isExpired(entry) ? null : entry.request();
    }

    private static String state(HttpServletRequest request) {
        return request.getParameter(OAuth2ParameterNames.STATE);
    }

    private boolean isExpired(Pending entry) {
        return clock.millis() - entry.savedAtMillis() > TTL.toMillis();
    }

    /** One stored authorization request and the instant it was saved. */
    private record Pending(OAuth2AuthorizationRequest request, long savedAtMillis) {
    }
}
