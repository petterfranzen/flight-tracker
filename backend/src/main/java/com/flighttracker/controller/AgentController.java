package com.flighttracker.controller;

import com.flighttracker.dto.PollingStatus;
import com.flighttracker.service.ClientIpResolver;
import com.flighttracker.service.HotPollUserBudget;
import com.flighttracker.service.PollWindowService;
import com.flighttracker.service.RestartRateLimiter;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.time.Duration;
import java.time.Instant;
import java.util.Optional;

@RestController
@RequestMapping("/api/agents")
public class AgentController {

    private final PollWindowService pollWindowService;
    private final RestartRateLimiter rateLimiter;
    private final HotPollUserBudget hotPollUserBudget;
    // Cloud migration security fix (PLAN.md §6 item 7): in production every
    // request arrives from cloudflared on 127.0.0.1, so ClientIpResolver.
    // isLocal(ip) alone would call *every* visitor local (see that method's
    // own javadoc) — trustLocal gates whether the local exemption applies
    // at all, defaulting to false so it's off unless explicitly enabled
    // (TRUST_LOCAL=true, for dev/local testing).
    private final boolean trustLocal;

    public AgentController(PollWindowService pollWindowService, RestartRateLimiter rateLimiter,
                            HotPollUserBudget hotPollUserBudget,
                            @Value("${flighttracker.rate-limit.trust-local:false}") boolean trustLocal) {
        this.pollWindowService = pollWindowService;
        this.rateLimiter = rateLimiter;
        this.hotPollUserBudget = hotPollUserBudget;
        this.trustLocal = trustLocal;
    }

    /** Whether the poll window is currently open, and how long until it closes — for a UI countdown. */
    @GetMapping("/status")
    public PollingStatus status() {
        return pollWindowService.status();
    }

    /**
     * Reopens the poll window (see PollWindowService) — called by the
     * frontend on page load if the window isn't already open (see
     * FlightMap.tsx's mount effect), and by its ResumeDialog's "Resume
     * tracking" button. Three independent things can reject this for a
     * public caller, all returning 429: the caller's own IP request-rate
     * limit (RestartRateLimiter), that same IP's daily hot-poll time
     * budget (HotPollUserBudget — how many seconds of hot polling this
     * specific caller has already been granted today, as opposed to how
     * many times they've asked), and the global restart quota
     * (PollWindowService — shared across every non-local caller, protects
     * OpenSky usage from the public internet-facing endpoint). All three
     * are skipped entirely for local/private-network callers when
     * trustLocal is enabled (see ClientIpResolver.isLocal and this class's
     * own trustLocal field) — in production (trustLocal=false, the
     * default) nothing is exempt, because every request now looks like it
     * came from 127.0.0.1 (cloudflared) regardless of who actually sent
     * it. Either way the body still carries the real current PollingStatus,
     * so the UI has something accurate to show either way.
     */
    @PostMapping("/restart")
    public ResponseEntity<PollingStatus> restart(HttpServletRequest request) {
        String ip = ClientIpResolver.resolve(request);
        boolean local = trustLocal && ClientIpResolver.isLocal(ip);
        Optional<String> rejected = rateLimiter.checkAndRecord(ip, local);
        if (rejected.isPresent()) {
            return ResponseEntity.status(429).body(pollWindowService.status());
        }

        if (!hotPollUserBudget.tryGrant(ip, local, pollWindowService.pollWindowSeconds())) {
            return ResponseEntity.status(429).body(pollWindowService.status());
        }

        Optional<Instant> quotaResetAt = pollWindowService.restart(local);
        if (quotaResetAt.isPresent()) {
            long retryAfterSeconds = Math.max(0, Duration.between(Instant.now(), quotaResetAt.get()).toSeconds());
            return ResponseEntity.status(429)
                    .header("Retry-After", String.valueOf(retryAfterSeconds))
                    .body(pollWindowService.status());
        }
        return ResponseEntity.ok(pollWindowService.status());
    }

    /** Closes the poll window immediately — wired to the frontend's stop button. */
    @PostMapping("/stop")
    public PollingStatus stop() {
        pollWindowService.stop();
        return pollWindowService.status();
    }
}
