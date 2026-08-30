package com.flighttracker.service;

import com.flighttracker.dto.PollingStatus;
import com.flighttracker.model.PollWindow;
import com.flighttracker.repository.PollWindowRepository;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Duration;
import java.time.Instant;
import java.util.Optional;

/**
 * Shared bounded-polling state — see the poll_window table comment in
 * schema.sql for why this is DB-backed rather than an in-memory
 * AtomicReference: AgentOrchestrator (the "agent" container, which decides
 * whether to actually poll) and AgentController (the "api" container,
 * which exposes GET/POST /api/agents/{status,restart} to the UI) are now
 * separate processes.
 */
@Service
public class PollWindowService {

    private static final Integer ROW_ID = 1;

    private final PollWindowRepository repository;
    private final Duration pollWindow;
    private final int quotaMax;
    private final Duration quotaWindow;

    public PollWindowService(PollWindowRepository repository,
                              @Value("${flighttracker.agents.poll-window-seconds}") long pollWindowSeconds,
                              @Value("${flighttracker.agents.restart-quota-max}") int quotaMax,
                              @Value("${flighttracker.agents.restart-quota-window-minutes}") long quotaWindowMinutes) {
        this.repository = repository;
        this.pollWindow = Duration.ofSeconds(pollWindowSeconds);
        this.quotaMax = quotaMax;
        this.quotaWindow = Duration.ofMinutes(quotaWindowMinutes);
    }

    /**
     * Reopens the window for another {@code pollWindow} from now — unless
     * the global restart quota (quotaMax resumes per quotaWindow, shared
     * across every caller) is already used up, in which case the window
     * is left exactly as it was and this returns when the quota resets.
     *
     * @param bypassQuota skip the quota check (and don't count this call
     *                    against it) entirely. Two legitimate reasons to:
     *                    AgentOrchestrator.seedOnStartup()'s boot-time
     *                    call isn't a request from anyone, there's no
     *                    "caller" for a quota to mean anything about; and
     *                    AgentController.restart() passes true for
     *                    local/private-network callers (see
     *                    ClientIpResolver.isLocal) — the quota exists to
     *                    protect the shared OpenSky budget from the
     *                    *public* internet-facing endpoint, not to throttle
     *                    the person who owns the deployment testing it
     *                    from their own machine or LAN. Note this only
     *                    means local callers can't be locked out by the
     *                    quota — OpenSky's own throttling (PollBackoff)
     *                    still applies regardless of who triggered a poll.
     * @return empty if the window was reopened; otherwise the instant the
     *         quota resets (quotaWindow after the *first* resume counted
     *         in the current quota window — not a rolling cooldown from
     *         this rejected attempt). Always empty when bypassQuota is true.
     */
    @Transactional
    public Optional<Instant> restart(boolean bypassQuota) {
        PollWindow window = repository.findById(ROW_ID).orElseGet(() -> new PollWindow(Instant.now()));
        Instant now = Instant.now();

        if (bypassQuota) {
            window.setActiveUntil(now.plus(pollWindow));
            repository.save(window);
            return Optional.empty();
        }

        Instant quotaWindowStart = window.getQuotaWindowStart();
        int count = window.getQuotaRestartCount();
        boolean expired = quotaWindowStart == null || Duration.between(quotaWindowStart, now).compareTo(quotaWindow) >= 0;
        if (expired) {
            quotaWindowStart = now;
            count = 0;
        }

        if (count >= quotaMax) {
            // Deliberately not saved: this attempt didn't count against
            // (or reset) the quota, so a caller retrying immediately
            // isn't punished further, and the quota resets at exactly
            // quotaWindow after the first resume that used it up.
            return Optional.of(quotaWindowStart.plus(quotaWindow));
        }

        window.setQuotaWindowStart(quotaWindowStart);
        window.setQuotaRestartCount(count + 1);
        window.setActiveUntil(now.plus(pollWindow));
        repository.save(window);
        return Optional.empty();
    }

    /** Closes the window immediately — wired to the frontend's "Stop Watch" button. */
    @Transactional
    public void stop() {
        PollWindow window = repository.findById(ROW_ID).orElseGet(() -> new PollWindow(Instant.now()));
        window.setActiveUntil(Instant.now());
        repository.save(window);
    }

    public boolean isActive() {
        return repository.findById(ROW_ID)
                .map(w -> Instant.now().isBefore(w.getActiveUntil()))
                .orElse(false);
    }

    public PollingStatus status() {
        Instant until = repository.findById(ROW_ID).map(PollWindow::getActiveUntil).orElse(Instant.EPOCH);
        Instant now = Instant.now();
        boolean active = now.isBefore(until);
        long secondsRemaining = active ? Duration.between(now, until).toSeconds() : 0;
        return new PollingStatus(active, secondsRemaining);
    }
}
