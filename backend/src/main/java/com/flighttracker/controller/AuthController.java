package com.flighttracker.controller;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import jakarta.servlet.http.HttpSession;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.http.HttpHeaders;
import org.springframework.http.ResponseCookie;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Signing out (design: section9-hq #84, step 3b-1).
 *
 * <p><b>Local logout only.</b> The server-side session is invalidated and the
 * session cookie cleared, so the very next request is anonymous. Nothing is sent
 * to the provider — no token revocation, no provider-side sign-out — because the
 * app never asked the provider for anything beyond the account id (design §1.5).
 *
 * <p>This is a state-changing {@code POST} and is covered by the same scoped CSRF
 * rule as the profile writes ({@link com.flighttracker.config.ProfileSecurityConfig}):
 * a POST with no token is a {@code 403}, exactly like {@code POST /api/profile},
 * while no other path gains a CSRF requirement.
 *
 * <p>Spring Security's own {@code LogoutFilter} and its generated {@code GET
 * /logout} page stay disabled — this endpoint is the app's whole sign-out story.
 *
 * <p>Mapped only with {@code flighttracker.profile.enabled=true}: with the flag
 * off there are no profile sessions to sign out of.
 */
@RestController
@RequestMapping("/api/auth")
@ConditionalOnProperty(prefix = "flighttracker.profile", name = "enabled", havingValue = "true")
public class AuthController {

    private final String sessionCookieName;
    private final String sessionCookiePath;
    private final boolean sessionCookieSecure;
    private final boolean sessionCookieHttpOnly;
    private final String sessionCookieSameSite;

    public AuthController(
            @Value("${server.servlet.session.cookie.name:JSESSIONID}") String sessionCookieName,
            @Value("${server.servlet.session.cookie.path:/}") String sessionCookiePath,
            @Value("${server.servlet.session.cookie.secure:false}") boolean sessionCookieSecure,
            @Value("${server.servlet.session.cookie.http-only:true}") boolean sessionCookieHttpOnly,
            @Value("${server.servlet.session.cookie.same-site:}") String sessionCookieSameSite) {
        this.sessionCookieName = sessionCookieName;
        this.sessionCookiePath = sessionCookiePath;
        this.sessionCookieSecure = sessionCookieSecure;
        this.sessionCookieHttpOnly = sessionCookieHttpOnly;
        this.sessionCookieSameSite = sessionCookieSameSite;
    }

    @PostMapping("/logout")
    public ResponseEntity<Void> logout(HttpServletRequest request, HttpServletResponse response) {
        HttpSession session = request.getSession(false);
        if (session != null) {
            session.invalidate();
        }
        response.addHeader(HttpHeaders.SET_COOKIE, clearedSessionCookie().toString());
        return ResponseEntity.noContent().build();
    }

    /**
     * The session cookie as a browser-clearing one: same name and path as the
     * cookie the container set, empty value and {@code Max-Age=0}, so the browser
     * drops it. Attributes mirror the app's own session cookie config.
     */
    private ResponseCookie clearedSessionCookie() {
        ResponseCookie.ResponseCookieBuilder builder = ResponseCookie.from(sessionCookieName, "")
                .path(sessionCookiePath)
                .maxAge(0);
        if (sessionCookieHttpOnly) {
            builder.httpOnly(true);
        }
        if (sessionCookieSecure) {
            builder.secure(true);
        }
        if (sessionCookieSameSite != null && !sessionCookieSameSite.isBlank()) {
            builder.sameSite(sessionCookieSameSite);
        }
        return builder.build();
    }
}
