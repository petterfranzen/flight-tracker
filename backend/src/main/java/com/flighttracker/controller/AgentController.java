package com.flighttracker.controller;

import com.flighttracker.config.AgentRequestGuard;
import com.flighttracker.dto.PollingStatus;
import com.flighttracker.service.ClientIpResolver;
import com.flighttracker.service.HotPollUserBudget;
import com.flighttracker.service.PollWindowService;
import com.flighttracker.service.RestartRateLimiter;
import jakarta.servlet.http.HttpServletRequest;
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
    private final ClientIpResolver clientIpResolver;
    // Origin allow-list plus the trust-local gate (PLAN.md §6 item 7) — both
    // decide whether a caller of this endpoint is trusted at all. See
    // AgentRequestGuard: in production every request arrives from cloudflared
    // on 127.0.0.1, so ClientIpResolver.isLocal(ip) alone would call *every*
    // visitor local; the guard's trust-local gate defaults to false.
    private final AgentRequestGuard requestGuard;

    public AgentController(PollWindowService pollWindowService, RestartRateLimiter rateLimiter,
                            HotPollUserBudget hotPollUserBudget, ClientIpResolver clientIpResolver,
                            AgentRequestGuard requestGuard) {
        this.pollWindowService = pollWindowService;
        this.rateLimiter = rateLimiter;
        this.hotPollUserBudget = hotPollUserBudget;
        this.clientIpResolver = clientIpResolver;
        this.requestGuard = requestGuard;
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
     * public caller, all returning 429: the caller's own rate-limit key
     * request-rate limit (RestartRateLimiter), that same key's daily
     * hot-poll time budget (HotPollUserBudget — how many seconds of hot
     * polling this caller has already been granted today, as opposed to how
     * many times they've asked), and this key's own restart quota
     * (PollWindowService — three reopens per 15 min *per key*, see below).
     * All three are skipped entirely for local/private-network callers when
     * the guard's trust-local gate is enabled (see ClientIpResolver.isLocal
     * and AgentRequestGuard) — in production (trust-local=false, the default)
     * nothing is exempt, because every request now looks like it came from
     * 127.0.0.1 (cloudflared) regardless of who actually sent it. Either way
     * the body still carries the real current PollingStatus, so the UI has
     * something accurate to show either way.
     *
     * <p>A request whose {@code Origin} names a page that is not this app's
     * is refused with 403 before any of that (finding M1: a simple cross-site
     * form POST used to be able to reopen the window for everyone).
     *
     * <p>The limiters and the quota are keyed by
     * {@link ClientIpResolver#rateLimitKey} — the /64 for IPv6 — so one
     * client cannot hold 2^64 identities, and the restart quota is charged
     * to the caller rather than to everyone combined.
     */
    @PostMapping("/restart")
    public ResponseEntity<PollingStatus> restart(HttpServletRequest request) {
        if (!requestGuard.allowsOrigin(request.getHeader("Origin"))) {
            return ResponseEntity.status(403).body(pollWindowService.status());
        }
        String ip = clientIpResolver.resolve(request);
        String key = ClientIpResolver.rateLimitKey(ip);
        boolean local = requestGuard.isLocalExempt(ip);
        Optional<String> rejected = rateLimiter.checkAndRecord(key, local);
        if (rejected.isPresent()) {
            return ResponseEntity.status(429).body(pollWindowService.status());
        }

        if (!hotPollUserBudget.tryGrant(key, local, pollWindowService.pollWindowSeconds())) {
            return ResponseEntity.status(429).body(pollWindowService.status());
        }

        Optional<Instant> quotaResetAt = pollWindowService.restart(key, local);
        if (quotaResetAt.isPresent()) {
            long retryAfterSeconds = Math.max(0, Duration.between(Instant.now(), quotaResetAt.get()).toSeconds());
            return ResponseEntity.status(429)
                    .header("Retry-After", String.valueOf(retryAfterSeconds))
                    .body(pollWindowService.status());
        }
        return ResponseEntity.ok(pollWindowService.status());
    }

    /**
     * Releases the caller's *own* grant on the poll window and leaves it open
     * for everyone else — wired to the frontend's stop button. Before finding
     * M1 this closed the shared window outright with no limiter and no auth,
     * so one request stopped live polling for every visitor; now a stop can
     * only take away the window this caller itself opened, and only while no
     * other client's grant is holding it open (see PollWindowService.stop).
     * A request whose {@code Origin} is not this app's is refused with 403,
     * like restart.
     */
    @PostMapping("/stop")
    public ResponseEntity<PollingStatus> stop(HttpServletRequest request) {
        if (!requestGuard.allowsOrigin(request.getHeader("Origin"))) {
            return ResponseEntity.status(403).body(pollWindowService.status());
        }
        String ip = clientIpResolver.resolve(request);
        pollWindowService.stop(ClientIpResolver.rateLimitKey(ip));
        return ResponseEntity.ok(pollWindowService.status());
    }
}
