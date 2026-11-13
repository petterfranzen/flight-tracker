package com.flighttracker.config;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.beans.factory.annotation.Value;
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
 */
@Component
public class SecurityHeadersFilter extends OncePerRequestFilter {

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

    public SecurityHeadersFilter(
            @Value("${flighttracker.security.csp-report-only:false}") boolean cspReportOnly) {
        this.cspHeader = cspReportOnly
                ? "Content-Security-Policy-Report-Only"
                : "Content-Security-Policy";
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
        chain.doFilter(request, response);
    }
}
