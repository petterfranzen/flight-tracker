package com.flighttracker.config;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.Ordered;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;

/**
 * Defence-in-depth response headers on every response (SPA, JSON and the
 * WebSocket 101 handshake all pass through the servlet chain). Finding H1 of
 * docs/agents/reviews/security-headers.md (#166).
 *
 * <p>The CSP is written for what the built app actually loads: the vanilla TS
 * bundle and its MapLibre worker (same origin, plus a {@code blob:} worker),
 * the OpenFreeMap vector tiles, TileJSON and glyph PBFs
 * ({@code tiles.openfreemap.org}, see {@code frontend/src/cyberpunkMapStyle.ts};
 * the style has no sprite), same-origin {@code fetch} and
 * {@code ws:}/{@code wss:} to the same host, and the service worker
 * ({@code /sw.js}). {@code style-src} keeps {@code 'unsafe-inline'} because
 * MapLibre and the UI set element styles at runtime. Fonts are bundled, so
 * {@code font-src} is {@code 'self'}.
 *
 * <p>HSTS is deliberately absent: the app speaks plain HTTP on loopback and TLS
 * terminates at Cloudflare, so it must be set at the edge (review, brief D).
 *
 * <p>{@code flighttracker.security.csp-report-only=true} (env
 * {@code FLIGHTTRACKER_CSP_REPORT_ONLY}) sends the policy as
 * {@code Content-Security-Policy-Report-Only} instead, as a roll-back that
 * needs no deploy of code.
 *
 * <p><b>Cache-Control on the auth surface (flag-on hardening, section9-hq
 * #326)</b>: while optional social login is on
 * ({@code flighttracker.profile.enabled=true}) the paths the feature owns —
 * {@code /api/profile/**}, {@code /api/auth/**} and the two OAuth redirects
 * ({@code /oauth2/authorization/*}, {@code /login/oauth2/code/*}) — are
 * {@code no-store}, so no shared cache anywhere between the browser and the app
 * holds a signed-in response or a redirect that carries a {@code state}. Spring
 * Security's own header writer used to add this; the flag-on chain disables it
 * so this filter is the one owner, and the value is set here so it lands on the
 * 401/403/302 the chain itself writes (the filter runs ahead of the chain on the
 * flag-on path). The flag-off path is untouched by design: it serves these
 * paths' 503/404 exactly as before.
 *
 * <p><b>Ordering (section9-hq #326)</b>: {@link #ORDER} puts the filter ahead of
 * Spring Security's chain (registered at {@code -100}), so the headers land on
 * the responses the chain itself writes — the {@code 401}, the CSRF {@code 403},
 * the two OAuth {@code 302}s, the StrictHttpFirewall {@code 400} and an
 * unknown-registration {@code 500} — not only on the ones that reach MVC. With
 * the flag off the chain writes nothing its container did not already write, so
 * the served headers are identical.
 */
@Component
public class SecurityHeadersFilter extends OncePerRequestFilter implements Ordered {

    /** Ahead of Spring Security's filter chain, which Boot registers at {@code -100}. */
    public static final int ORDER = -110;

    static final String CSP = String.join("; ",
            "default-src 'self'",
            "base-uri 'self'",
            "object-src 'none'",
            "frame-ancestors 'none'",
            "form-action 'self'",
            "script-src 'self'",
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data: blob:",
            "connect-src 'self' https://tiles.openfreemap.org",
            "worker-src 'self' blob:",
            "manifest-src 'self'",
            "font-src 'self'");

    private final String cspHeader;
    private final boolean noStoreOnAuthPaths;

    public SecurityHeadersFilter(
            @Value("${flighttracker.security.csp-report-only:false}") boolean cspReportOnly,
            @Value("${flighttracker.profile.enabled:false}") boolean profileEnabled) {
        this.cspHeader = cspReportOnly
                ? "Content-Security-Policy-Report-Only"
                : "Content-Security-Policy";
        // Only the flag-on path gains no-store: the auth surface only exists then.
        this.noStoreOnAuthPaths = profileEnabled;
    }

    /**
     * The paths the optional-login feature owns, matched by prefix: the profile
     * read/write API, the sign-out POST, and the two OAuth redirects the browser
     * is sent through. Kept in step with {@code ProfileSecurityConfig}'s path
     * constants by {@code ProfileSecurityChainTest}.
     */
    static boolean isNoStorePath(String uri) {
        return uri != null
                && (uri.startsWith("/api/profile")
                        || uri.startsWith("/api/auth")
                        || uri.startsWith("/oauth2/authorization/")
                        || uri.startsWith("/login/oauth2/code/"));
    }

    @Override
    public int getOrder() {
        return ORDER;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response,
                                    FilterChain chain) throws ServletException, IOException {
        response.setHeader("X-Content-Type-Options", "nosniff");
        response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
        response.setHeader("Permissions-Policy",
                "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()");
        // Legacy twin of frame-ancestors 'none'.
        response.setHeader("X-Frame-Options", "DENY");
        response.setHeader(cspHeader, CSP);
        if (noStoreOnAuthPaths && isNoStorePath(request.getRequestURI())) {
            response.setHeader("Cache-Control", "no-store");
        }
        chain.doFilter(request, response);
    }
}
