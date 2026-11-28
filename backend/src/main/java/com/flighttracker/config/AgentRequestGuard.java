package com.flighttracker.config;

import com.flighttracker.service.ClientIpResolver;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.util.Arrays;
import java.util.Locale;
import java.util.Set;

/**
 * The trust policy for the state-changing {@code POST /api/agents/*} endpoints:
 * who is calling, and whether that caller is allowed (finding M1 of the
 * security audit, section9-hq #405).
 *
 * <p>{@link #allowsOrigin} refuses a request driven from another site's page: a
 * browser sends {@code Origin} on every cross-site POST, so a caller from
 * another site carries that site's origin and is refused, while a non-browser
 * client (curl, a script, the blackbox suite) sends no {@code Origin} at all and
 * is allowed, because it is not a CSRF. The allowed list is the same
 * per-page-origin list the WebSocket handshake uses
 * ({@code flighttracker.ws.allowed-origins}, {@link WebSocketConfig#parse}) — one
 * list of "pages that may talk to this app" shared by both transports, so the
 * two cannot drift apart.
 *
 * <p>{@link #isLocalExempt} is the trust-local gate (PLAN.md §6 item 7): the
 * local/private-network exemption from the rate limiters applies only when
 * {@code flighttracker.rate-limit.trust-local} says so, because in production
 * every request arrives from cloudflared on 127.0.0.1 and would otherwise look
 * local to everyone (see {@link ClientIpResolver#isLocal}).
 */
@Component
public class AgentRequestGuard {

    private final Set<String> allowedOrigins;
    private final boolean trustLocal;

    public AgentRequestGuard(@Value("${flighttracker.ws.allowed-origins}") String allowedOrigins,
                              @Value("${flighttracker.rate-limit.trust-local:false}") boolean trustLocal) {
        this.allowedOrigins = Set.copyOf(Arrays.stream(WebSocketConfig.parse(allowedOrigins))
                .map(origin -> origin.toLowerCase(Locale.ROOT))
                .toList());
        this.trustLocal = trustLocal;
    }

    /** True when origin is absent or blank (not a browser) or is one of the app's own page origins. */
    public boolean allowsOrigin(String origin) {
        return origin == null || origin.isBlank() || allowedOrigins.contains(origin.trim().toLowerCase(Locale.ROOT));
    }

    /** True when the trust-local exemption is enabled and ip answers to it. */
    public boolean isLocalExempt(String ip) {
        return trustLocal && ClientIpResolver.isLocal(ip);
    }
}
