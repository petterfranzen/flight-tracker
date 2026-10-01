package com.flighttracker.service;

import com.flighttracker.dto.PollingStatus;
import com.flighttracker.repository.AppStateRepository;
import jakarta.annotation.PostConstruct;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.time.Duration;
import java.time.Instant;
import java.util.Optional;

/**
 * Shared bounded-polling state — see AgentOrchestrator (which decides
 * whether to actually poll) and AgentController (which exposes GET/POST
 * /api/agents/{status,restart} to the UI).
 *
 * Cloud migration A1 (PLAN.md §6 item 6): this used to be backed by the
 * poll_window table because the "agent" and "api" containers were separate
 * processes with no way to share an in-memory AtomicReference. Now that
 * everything is one process, activeUntil/quotaWindowStart/quotaRestartCount
 * are plain synchronized fields again — the same shape this had before the
 * multi-container split, and a restart resetting them is fine (it was fine
 * then too). The one exception is the global hot-poll-daily-call-budget
 * counter (hotPollCountWindowStart/hotPollCallCount): "the original design
 * requirement" is that this specific budget survive a restart, so it's
 * still write-through persisted — to the small app_state table
 * (AppStateRepository) instead of poll_window now.
 */
@Service
public class PollWindowService {

    // Rolling window the global hot-poll call budget resets over — a
    // calendar day would let a caller near midnight "reset" the budget
    // early; a rolling 24h from the first call counted doesn't have that
    // edge, at the cost of not lining up with a fixed daily boundary
    // (irrelevant here — nothing displays "today's calls", just whether
    // the budget is currently available).
    private static final Duration HOT_POLL_BUDGET_WINDOW = Duration.ofDays(1);

    private static final String HOT_POLL_WINDOW_START_KEY = "hotpoll.window_start";
    private static final String HOT_POLL_CALL_COUNT_KEY = "hotpoll.call_count";

    private final AppStateRepository appState;
    private final Duration pollWindow;
    private final int quotaMax;
    private final Duration quotaWindow;
    private final int hotPollDailyCallBudget;

    // Plain fields guarded by `this` monitor (see the synchronized methods
    // below) — a single shared "one map, one poll window" model, same as
    // before this app ever had multiple containers.
    private Instant activeUntil = Instant.EPOCH;
    private Instant quotaWindowStart;
    private int quotaRestartCount = 0;

    private Instant hotPollCountWindowStart;
    private int hotPollCallCount = 0;

    public PollWindowService(AppStateRepository appState,
                              @Value("${flighttracker.agents.poll-window-seconds}") long pollWindowSeconds,
                              @Value("${flighttracker.agents.restart-quota-max}") int quotaMax,
                              @Value("${flighttracker.agents.restart-quota-window-minutes}") long quotaWindowMinutes,
                              @Value("${flighttracker.agents.hot-poll-daily-call-budget}") int hotPollDailyCallBudget) {
        this.appState = appState;
        this.pollWindow = Duration.ofSeconds(pollWindowSeconds);
        this.quotaMax = quotaMax;
        this.quotaWindow = Duration.ofMinutes(quotaWindowMinutes);
        this.hotPollDailyCallBudget = hotPollDailyCallBudget;
    }

    /** Restores the hot-poll call budget counter across a restart — see this class's own javadoc for why only this one survives. */
    @PostConstruct
    synchronized void loadHotPollBudget() {
        hotPollCountWindowStart = appState.get(HOT_POLL_WINDOW_START_KEY).map(Instant::parse).orElse(null);
        hotPollCallCount = appState.get(HOT_POLL_CALL_COUNT_KEY).map(Integer::parseInt).orElse(0);
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
    public synchronized Optional<Instant> restart(boolean bypassQuota) {
        Instant now = Instant.now();

        if (bypassQuota) {
            activeUntil = now.plus(pollWindow);
            return Optional.empty();
        }

        boolean expired = quotaWindowStart == null || Duration.between(quotaWindowStart, now).compareTo(quotaWindow) >= 0;
        if (expired) {
            quotaWindowStart = now;
            quotaRestartCount = 0;
        }

        if (quotaRestartCount >= quotaMax) {
            // Deliberately not counted: this attempt didn't count against
            // (or reset) the quota, so a caller retrying immediately
            // isn't punished further, and the quota resets at exactly
            // quotaWindow after the first resume that used it up.
            return Optional.of(quotaWindowStart.plus(quotaWindow));
        }

        quotaRestartCount++;
        activeUntil = now.plus(pollWindow);
        return Optional.empty();
    }

    /** Closes the window immediately — wired to the frontend's "Stop Watch" button. */
    public synchronized void stop() {
        activeUntil = Instant.now();
    }

    public synchronized boolean isActive() {
        return Instant.now().isBefore(activeUntil);
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
    public synchronized boolean hotPollBudgetAvailable() {
        boolean expired = hotPollCountWindowStart == null
                || Duration.between(hotPollCountWindowStart, Instant.now()).compareTo(HOT_POLL_BUDGET_WINDOW) >= 0;
        int count = expired ? 0 : hotPollCallCount;
        return count < hotPollDailyCallBudget;
    }

    /**
     * Records one hot-poll call against the global budget — call exactly
     * once per actual hot-poll attempt (see AgentOrchestrator.pollAll()),
     * after confirming hotPollBudgetAvailable() was true. Resets the
     * rolling window the same way restart()'s quota does: the count starts
     * over once HOT_POLL_BUDGET_WINDOW has fully elapsed since the first
     * call counted in the current window, not on a fixed daily boundary.
     * Write-through to app_state on every call — see this class's own
     * javadoc for why this specific counter, unlike the rest of this
     * service's state, needs to survive a restart.
     */
    public synchronized void recordHotPollCall() {
        Instant now = Instant.now();
        boolean expired = hotPollCountWindowStart == null
                || Duration.between(hotPollCountWindowStart, now).compareTo(HOT_POLL_BUDGET_WINDOW) >= 0;
        if (expired) {
            hotPollCountWindowStart = now;
            hotPollCallCount = 1;
        } else {
            hotPollCallCount++;
        }
        appState.put(HOT_POLL_WINDOW_START_KEY, hotPollCountWindowStart.toString());
        appState.put(HOT_POLL_CALL_COUNT_KEY, String.valueOf(hotPollCallCount));
    }

    public synchronized PollingStatus status() {
        Instant now = Instant.now();
        boolean active = now.isBefore(activeUntil);
        long secondsRemaining = active ? Duration.between(now, activeUntil).toSeconds() : 0;
        return new PollingStatus(active, secondsRemaining);
    }
}
