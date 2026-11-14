package com.flighttracker.config;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import jakarta.servlet.http.HttpSession;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.time.Clock;
import java.time.Duration;

/**
 * The absolute session lifetime (design: section9-hq #84, step 3b-1).
 *
 * <p>{@code server.servlet.session.timeout} (24h) is an <em>idle</em> timeout: a
 * client that keeps touching the app can hold a session open indefinitely. A
 * signed-in profile session must not: whatever its activity, it is forced to sign
 * in again once it is older than {@link #ABSOLUTE_SESSION_CAP}, measured from the
 * session's own creation time.
 *
 * <p>Registered ahead of Spring Security's chain, so an expired session is
 * invalidated <em>before</em> the security context is restored from it: the
 * request in flight cannot authenticate off a session that is past the cap, and
 * the next request is anonymous.
 *
 * <p>Only installed with {@code flighttracker.profile.enabled=true} — see
 * {@link ProfileSecurityConfig#absoluteSessionFilter}.
 */
public class AbsoluteSessionFilter extends OncePerRequestFilter {

    /** The maximum wall-clock age of a session, however busy it is. */
    static final Duration ABSOLUTE_SESSION_CAP = Duration.ofDays(30);

    private final Duration cap;
    private final Clock clock;

    AbsoluteSessionFilter(Duration cap, Clock clock) {
        this.cap = cap;
        this.clock = clock;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        HttpSession session = request.getSession(false);
        if (session != null && isExpired(session)) {
            session.invalidate();
        }
        chain.doFilter(request, response);
    }

    /** True when the session was created more than {@link #cap} before "now". */
    boolean isExpired(HttpSession session) {
        return clock.millis() - session.getCreationTime() > cap.toMillis();
    }
}
