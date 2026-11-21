package com.flighttracker.controller;

import com.flighttracker.config.AgentRequestGuard;
import com.flighttracker.dto.PollingStatus;
import com.flighttracker.repository.AppStateRepository;
import com.flighttracker.service.ClientIpResolver;
import com.flighttracker.service.HotPollUserBudget;
import com.flighttracker.service.PollWindowService;
import com.flighttracker.service.RestartRateLimiter;
import jakarta.servlet.http.HttpServletRequest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.http.ResponseEntity;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.lenient;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * Covers Gate A1's specific checklist item (PLAN.md §7): with
 * flighttracker.rate-limit.trust-local=false, a request whose
 * CF-Connecting-IP header says 203.0.113.9 — even though it physically
 * arrived from loopback, as every request now does behind cloudflared —
 * is rate-limited *as* 203.0.113.9, not exempted as local. Uses real
 * RestartRateLimiter/HotPollUserBudget/PollWindowService instances (all
 * cheap, in-memory-backed) rather than mocking the collaborators, since
 * the behaviour under test is genuinely the interaction between
 * AgentController's trust-local gate and those services' own per-key
 * bookkeeping.
 *
 * <p>Also covers finding M1 (section9-hq #405): a cross-site Origin is
 * refused on both POSTs before anything is charged, and a stop releases only
 * the caller's own grant rather than closing the shared window for everyone.
 */
@ExtendWith(MockitoExtension.class)
class AgentControllerTest {

    private static final String SITE_ORIGIN = "https://flight.pastabake.cloud";

    @Mock
    private AppStateRepository appState;
    @Mock
    private HttpServletRequest request;

    private AgentRequestGuard guard(boolean trustLocal) {
        return new AgentRequestGuard(SITE_ORIGIN, trustLocal);
    }

    private AgentController controllerWithTrustLocal(boolean trustLocal) {
        // Neither service's own @PostConstruct load-from-app_state method
        // is called here (they're package-private, invoked only by Spring
        // normally) — starting them unloaded is equivalent to loading from
        // a genuinely empty app_state, which is exactly what the mocked
        // appState (no stubbing needed — Mockito's default Optional-typed
        // return is empty) represents anyway.
        lenient().when(appState.get(org.mockito.ArgumentMatchers.any())).thenReturn(java.util.Optional.empty());
        // No Origin on the shared mock unless a test sets one (a non-browser
        // client); lenient so tests that never reach the Origin check pass.
        lenient().when(request.getHeader("Origin")).thenReturn(null);

        RestartRateLimiter rateLimiter = new RestartRateLimiter(3, 20);
        HotPollUserBudget hotPollUserBudget = new HotPollUserBudget(appState, 4500);
        PollWindowService pollWindowService = new PollWindowService(appState, 300, 3, 15, 3000);

        return new AgentController(pollWindowService, rateLimiter, hotPollUserBudget,
                new ClientIpResolver("127.0.0.1,::1"), guard(trustLocal));
    }

    /** A request claiming a given public address, arrived-from-loopback like every real one. */
    private HttpServletRequest visitorFrom(String publicIp) {
        HttpServletRequest req = mock(HttpServletRequest.class);
        when(req.getRemoteAddr()).thenReturn("127.0.0.1"); // the tunnel
        lenient().when(req.getHeader("CF-Connecting-IP")).thenReturn(publicIp);
        lenient().when(req.getHeader("Origin")).thenReturn(null);
        return req;
    }

    @Test
    void trustLocalFalse_cfConnectingIpFromLoopback_rateLimitedAsThatIpNotExemptedAsLocal() {
        AgentController controller = controllerWithTrustLocal(false);
        // getRemoteAddr() is never consulted here — resolve() prefers
        // CF-Connecting-IP outright — but in a real deployment behind
        // cloudflared it actually would say 127.0.0.1, which is exactly
        // the scenario this fix protects against (see ClientIpResolver's
        // javadoc): the header's public IP wins the rate-limit identity,
        // not the loopback transport address underneath it.
        when(request.getRemoteAddr()).thenReturn("127.0.0.1"); // the tunnel
        when(request.getHeader("CF-Connecting-IP")).thenReturn("203.0.113.9");

        // restart-per-ip-per-minute is 3 — the 4th call within a minute must be rejected.
        ResponseEntity<PollingStatus> r1 = controller.restart(request);
        ResponseEntity<PollingStatus> r2 = controller.restart(request);
        ResponseEntity<PollingStatus> r3 = controller.restart(request);
        ResponseEntity<PollingStatus> r4 = controller.restart(request);

        assertThat(r1.getStatusCode().value()).isEqualTo(200);
        assertThat(r2.getStatusCode().value()).isEqualTo(200);
        assertThat(r3.getStatusCode().value()).isEqualTo(200);
        assertThat(r4.getStatusCode().value()).isEqualTo(429);
    }

    @Test
    void spoofedForwardedForFromAnUntrustedPeer_cannotEvadeThePerIpLimiter() {
        AgentController controller = controllerWithTrustLocal(false);
        when(request.getRemoteAddr()).thenReturn("198.51.100.5"); // not the tunnel
        // A fresh X-Forwarded-For / CF-Connecting-IP on every call would
        // be a fresh limiter key if the headers were believed.
        lenient().when(request.getHeader("CF-Connecting-IP")).thenReturn("203.0.113.1", "203.0.113.2", "203.0.113.3", "203.0.113.4");
        lenient().when(request.getHeader("X-Forwarded-For")).thenReturn("203.0.113.1", "203.0.113.2", "203.0.113.3", "203.0.113.4");

        assertThat(controller.restart(request).getStatusCode().value()).isEqualTo(200);
        assertThat(controller.restart(request).getStatusCode().value()).isEqualTo(200);
        assertThat(controller.restart(request).getStatusCode().value()).isEqualTo(200);
        assertThat(controller.restart(request).getStatusCode().value()).isEqualTo(429);
    }

    @Test
    void trustLocalTrue_genuinelyLocalCaller_exemptFromRateLimiting() {
        // No CF-Connecting-IP/X-Real-IP/X-Forwarded-For here — this is the
        // dev/local scenario trust-local=true exists for (see
        // ClientIpResolver's javadoc), where resolve() falls through to
        // the raw remote address and that address genuinely is loopback.
        AgentController controller = controllerWithTrustLocal(true);
        when(request.getRemoteAddr()).thenReturn("127.0.0.1");

        // Same four-or-more calls that would 429 under trust-local=false
        // all succeed here, because ClientIpResolver.isLocal is actually
        // consulted this time (127.0.0.1 is loopback) and every limiter
        // exempts local callers.
        for (int i = 0; i < 6; i++) {
            ResponseEntity<PollingStatus> r = controller.restart(request);
            assertThat(r.getStatusCode().value()).isEqualTo(200);
        }
    }

    @Test
    void twoAddressesInOneIpv6Slash64ShareTheRateLimitKey() {
        // Finding M3: an IPv6 client is handed 2^64 addresses, so keying the
        // limiters on the full address would give it 2^64 identities. Two
        // different /128s inside one /64 must share the 3-per-minute allowance.
        AgentController controller = controllerWithTrustLocal(false);
        when(request.getRemoteAddr()).thenReturn("127.0.0.1");
        lenient().when(request.getHeader("CF-Connecting-IP"))
                .thenReturn("2001:db8:1:2::1", "2001:db8:1:2::9", "2001:db8:1:2::a", "2001:db8:1:2::b");

        assertThat(controller.restart(request).getStatusCode().value()).isEqualTo(200);
        assertThat(controller.restart(request).getStatusCode().value()).isEqualTo(200);
        assertThat(controller.restart(request).getStatusCode().value()).isEqualTo(200);
        assertThat(controller.restart(request).getStatusCode().value())
                .as("the 4th /128 sibling is still the same /64 key")
                .isEqualTo(429);
    }

    @Test
    void aCrossSiteOriginIsRefusedOnBothPosts_andTheWindowIsUntouched() {
        AgentController controller = controllerWithTrustLocal(false);
        // The Origin check refuses before resolve(), so this request needs no
        // address stub at all.
        when(request.getHeader("Origin")).thenReturn("https://evil.example");

        assertThat(controller.restart(request).getStatusCode().value()).isEqualTo(403);
        assertThat(controller.stop(request).getStatusCode().value()).isEqualTo(403);
        assertThat(controller.status().active())
                .as("a refused cross-site request must not open the shared window")
                .isFalse();
    }

    @Test
    void theAppsOwnOriginIsAccepted() {
        AgentController controller = controllerWithTrustLocal(false);
        when(request.getRemoteAddr()).thenReturn("198.51.100.5");
        when(request.getHeader("Origin")).thenReturn(SITE_ORIGIN);

        assertThat(controller.restart(request).getStatusCode().value()).isEqualTo(200);
    }

    @Test
    void aRequestWithNoOrigin_nonBrowserClient_isAccepted() {
        AgentController controller = controllerWithTrustLocal(false);
        when(request.getRemoteAddr()).thenReturn("198.51.100.5");
        // getHeader("Origin") returns null — curl, a script, the blackbox suite.
        assertThat(controller.restart(request).getStatusCode().value()).isEqualTo(200);
    }

    @Test
    void stopReleasesOnlyTheCallersOwnGrant_theWindowStaysOpenForOthers() {
        // Two visitors each hold a grant; one visitor's stop must take back
        // only its own grant and leave the other's holding the window open
        // (finding M1 — this used to close it for everyone).
        AppStateRepository state = mock(AppStateRepository.class);
        PollWindowService window = new PollWindowService(state, 300, 3, 15, 3000);
        AgentController controller = new AgentController(window, new RestartRateLimiter(10, 20),
                new HotPollUserBudget(state, 4500), new ClientIpResolver("127.0.0.1,::1"), guard(false));

        HttpServletRequest a = visitorFrom("203.0.113.9");
        HttpServletRequest b = visitorFrom("203.0.113.10");
        assertThat(controller.restart(a).getStatusCode().value()).isEqualTo(200);
        assertThat(controller.restart(b).getStatusCode().value()).isEqualTo(200);
        assertThat(controller.status().active()).isTrue();

        controller.stop(a);
        assertThat(controller.status().active())
                .as("visitor B's grant still holds the window open after A stops")
                .isTrue();

        controller.stop(b);
        assertThat(controller.status().active()).isFalse();
    }

    @Test
    void stopClosesTheWindowWhenTheCallerIsTheOnlyOne() {
        AgentController controller = controllerWithTrustLocal(false);
        when(request.getRemoteAddr()).thenReturn("198.51.100.5");

        controller.restart(request);
        assertThat(controller.status().active()).isTrue();

        controller.stop(request);
        assertThat(controller.status().active()).isFalse();
    }
}
