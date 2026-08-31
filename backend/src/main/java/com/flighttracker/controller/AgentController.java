package com.flighttracker.controller;

import com.flighttracker.dto.PollingStatus;
import com.flighttracker.service.ClientIpResolver;
import com.flighttracker.service.PollWindowService;
import com.flighttracker.service.RestartRateLimiter;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.context.annotation.Profile;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.time.Duration;
import java.time.Instant;
import java.util.Optional;

@RestController
@RequestMapping("/api/agents")
@Profile("api")
public class AgentController {

    private final PollWindowService pollWindowService;
    private final RestartRateLimiter rateLimiter;

    public AgentController(PollWindowService pollWindowService, RestartRateLimiter rateLimiter) {
        this.pollWindowService = pollWindowService;
        this.rateLimiter = rateLimiter;
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
     * tracking" button. Two independent things can reject
     * this for a public caller, both returning 429: the caller's own IP
     * rate limit (RestartRateLimiter), and the global restart quota
     * (PollWindowService — shared across every non-local caller, protects
     * OpenSky usage from the public internet-facing endpoint). Both are
     * skipped entirely for local/private-network callers (see
     * ClientIpResolver.isLocal) — the owner of the deployment testing it
     * from their own machine or LAN isn't who either limit exists for.
     * Either way the body still carries the real current PollingStatus, so
     * the UI has something accurate to show either way.
     */
    @PostMapping("/restart")
    public ResponseEntity<PollingStatus> restart(HttpServletRequest request) {
        String ip = ClientIpResolver.resolve(request);
        boolean local = ClientIpResolver.isLocal(ip);
        Optional<String> rejected = rateLimiter.checkAndRecord(ip, local);
        if (rejected.isPresent()) {
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
