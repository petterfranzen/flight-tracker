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

    // Rolling window the global hot-poll call budget resets over — a
    // calendar day would let a caller near midnight "reset" the budget
    // early; a rolling 24h from the first call counted doesn't have that
    // edge, at the cost of not lining up with a fixed daily boundary
    // (irrelevant here — nothing displays "today's calls", just whether
    // the budget is currently available).
    private static final Duration HOT_POLL_BUDGET_WINDOW = Duration.ofDays(1);

    private final PollWindowRepository repository;
    private final Duration pollWindow;
    private final int quotaMax;
    private final Duration quotaWindow;
    private final int hotPollDailyCallBudget;

    public PollWindowService(PollWindowRepository repository,
                              @Value("${flighttracker.agents.poll-window-seconds}") long pollWindowSeconds,
                              @Value("${flighttracker.agents.restart-quota-max}") int quotaMax,
                              @Value("${flighttracker.agents.restart-quota-window-minutes}") long quotaWindowMinutes,
                              @Value("${flighttracker.agents.hot-poll-daily-call-budget}") int hotPollDailyCallBudget) {
        this.repository = repository;
        this.pollWindow = Duration.ofSeconds(pollWindowSeconds);
        this.quotaMax = quotaMax;
        this.quotaWindow = Duration.ofMinutes(quotaWindowMinutes);
        this.hotPollDailyCallBudget = hotPollDailyCallBudget;
    }

    /** How long a single restart()/reopen grants — what a caller "gets" per grant, in seconds. */
    public long pollWindowSeconds() {
        return pollWindow.getSeconds();
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

    /**
     * Whether the global hot-poll call budget (hot-poll-daily-call-budget,
     * per rolling 24h, across every caller combined) still has room for
     * another call — checked by AgentOrchestrator.pollAll() before it
     * actually polls, independent of whether the poll window itself is
     * open. Read-only: unlike recordHotPollCall(), this never resets or
     * advances the window itself, so calling it repeatedly (e.g. once to
     * decide whether to poll, again for logging) is always safe.
     */
    public boolean hotPollBudgetAvailable() {
        PollWindow window = repository.findById(ROW_ID).orElseGet(() -> new PollWindow(Instant.now()));
        Instant start = window.getHotPollCountWindowStart();
        boolean expired = start == null || Duration.between(start, Instant.now()).compareTo(HOT_POLL_BUDGET_WINDOW) >= 0;
        int count = expired ? 0 : window.getHotPollCallCount();
        return count < hotPollDailyCallBudget;
    }

    /**
     * Records one hot-poll call against the global budget — call exactly
     * once per actual hot-poll attempt (see AgentOrchestrator.pollAll()),
     * after confirming hotPollBudgetAvailable() was true. Resets the
     * rolling window the same way restart()'s quota does: the count starts
     * over once HOT_POLL_BUDGET_WINDOW has fully elapsed since the first
     * call counted in the current window, not on a fixed daily boundary.
     */
    @Transactional
    public void recordHotPollCall() {
        PollWindow window = repository.findById(ROW_ID).orElseGet(() -> new PollWindow(Instant.now()));
        Instant now = Instant.now();
        Instant start = window.getHotPollCountWindowStart();
        boolean expired = start == null || Duration.between(start, now).compareTo(HOT_POLL_BUDGET_WINDOW) >= 0;
        if (expired) {
            window.setHotPollCountWindowStart(now);
            window.setHotPollCallCount(1);
        } else {
            window.setHotPollCallCount(window.getHotPollCallCount() + 1);
        }
        repository.save(window);
    }

    public PollingStatus status() {
        Instant until = repository.findById(ROW_ID).map(PollWindow::getActiveUntil).orElse(Instant.EPOCH);
        Instant now = Instant.now();
        boolean active = now.isBefore(until);
        long secondsRemaining = active ? Duration.between(now, until).toSeconds() : 0;
        return new PollingStatus(active, secondsRemaining);
    }
}
