package com.flighttracker.controller;

import com.flighttracker.dto.PollingStatus;
import com.flighttracker.repository.AppStateRepository;
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
 * AgentController's trust-local gate and those services' own per-IP
 * bookkeeping.
 */
@ExtendWith(MockitoExtension.class)
class AgentControllerTest {

    @Mock
    private AppStateRepository appState;
    @Mock
    private HttpServletRequest request;

    private AgentController controllerWithTrustLocal(boolean trustLocal) {
        // Neither service's own @PostConstruct load-from-app_state method
        // is called here (they're package-private, invoked only by Spring
        // normally) — starting them unloaded is equivalent to loading from
        // a genuinely empty app_state, which is exactly what the mocked
        // appState (no stubbing needed — Mockito's default Optional-typed
        // return is empty) represents anyway.
        lenient().when(appState.get(org.mockito.ArgumentMatchers.any())).thenReturn(java.util.Optional.empty());

        RestartRateLimiter rateLimiter = new RestartRateLimiter(3, 20);
        HotPollUserBudget hotPollUserBudget = new HotPollUserBudget(appState, 4500);
        PollWindowService pollWindowService = new PollWindowService(appState, 300, 3, 15, 3000);

        return new AgentController(pollWindowService, rateLimiter, hotPollUserBudget, trustLocal);
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
}
