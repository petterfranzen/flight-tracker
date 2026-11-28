package com.flighttracker.service;

import com.flighttracker.dto.PollingStatus;
import com.flighttracker.repository.AppStateRepository;
import jakarta.annotation.PostConstruct;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.time.Duration;
import java.time.Instant;
import java.util.Comparator;
import java.util.HashMap;
import java.util.Map;
import java.util.Optional;

/**
 * Shared bounded-polling state — see AgentOrchestrator (which decides
 * whether to actually poll) and AgentController (which exposes GET/POST
 * /api/agents/{status,restart,stop} to the UI).
 *
 * <p>The window is held open by <b>grants</b>: each reopen records a grant
 * for the caller (its {@link ClientIpResolver#rateLimitKey}), and the window
 * is open while any grant is still in its future. This is what lets a stop
 * release only the caller's own grant while other clients' grants keep the
 * window open (security audit finding M1, section9-hq #405) — the old single
 * {@code activeUntil} made one unauthenticated stop close it for everyone.
 *
 * <p>The restart quota is charged per key, not globally: the old shared
 * counter let a single IP spend the whole {@code restart-quota-max} allowance
 * and lock every other visitor out of the window for the rest of the window
 * (finding M1). Per key, one caller's bursts only affect that caller.
 *
 * <p>Cloud migration A1 (PLAN.md §6 item 6): this used to be backed by the
 * poll_window table because the "agent" and "api" containers were separate
 * processes with no way to share an in-memory map. Now that everything is one
 * process, the grants and per-key quotas are plain synchronized maps again —
 * the same shape this had before the multi-container split, and a restart
 * resetting them is fine (it was fine then too). The one exception is the
 * global hot-poll-daily-call-budget counter
 * (hotPollCountWindowStart/hotPollCallCount): "the original design
 * requirement" is that this specific budget survive a restart, so it's still
 * write-through persisted — to the small app_state table (AppStateRepository)
 * instead of poll_window now.
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

    // The grant the boot-time, caller-less seed (AgentOrchestrator.
    // seedOnStartup) records under — no request, so no client key.
    private static final String BOOT_GRANT_KEY = "boot";

    private final AppStateRepository appState;
    private final Duration pollWindow;
    private final int quotaMax;
    private final Duration quotaWindow;
    private final int hotPollDailyCallBudget;

    // Plain maps guarded by `this` monitor (see the synchronized methods
    // below) — a single shared "one poll window" model, same as before this
    // app ever had multiple containers. grants: key -> when its grant ends,
    // pruned as it lapses. restarts: key -> its count in the current quota
    // window, pruned once that window is over.
    private final Map<String, Instant> grants = new HashMap<>();
    private final Map<String, Quota> restarts = new HashMap<>();

    private Instant hotPollCountWindowStart;
    private int hotPollCallCount = 0;

    /** One key's reopen count within a single quota window. */
    private record Quota(Instant windowStart, int count) {
    }

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
     * Reopens the window for another {@code pollWindow} from now, for a
     * caller with no key (the boot-time seed). See {@link #restart(String, boolean)}.
     */
    public synchronized Optional<Instant> restart(boolean bypassQuota) {
        return restart(BOOT_GRANT_KEY, bypassQuota);
    }

    /**
     * Records a grant for {@code key} (reopening the window for another
     * {@code pollWindow} from now) — unless this key has already used up its
     * restart quota (quotaMax reopens per quotaWindow, charged per key), in
     * which case nothing changes and this returns when that key's quota
     * resets.
     *
     * @param key         the caller's rate-limit key ({@link ClientIpResolver#rateLimitKey}).
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
     * @return empty if the window was reopened; otherwise the instant this
     *         key's quota resets (quotaWindow after the *first* reopen counted
     *         in the current quota window — not a rolling cooldown from
     *         this rejected attempt). Always empty when bypassQuota is true.
     */
    public synchronized Optional<Instant> restart(String key, boolean bypassQuota) {
        Instant now = Instant.now();
        prune(now);

        if (bypassQuota) {
            grants.put(key, now.plus(pollWindow));
            return Optional.empty();
        }

        Quota quota = activeQuota(key, now);
        if (quota.count() >= quotaMax) {
            // Deliberately not counted: this attempt didn't count against
            // (or reset) the quota, so a caller retrying immediately
            // isn't punished further, and the quota resets at exactly
            // quotaWindow after the first reopen that used it up.
            restarts.put(key, quota);
            return Optional.of(quota.windowStart().plus(quotaWindow));
        }

        restarts.put(key, new Quota(quota.windowStart(), quota.count() + 1));
        grants.put(key, now.plus(pollWindow));
        return Optional.empty();
    }

    /** {@code key}'s quota in the current window, or one starting now when its window has elapsed. */
    private Quota activeQuota(String key, Instant now) {
        Quota quota = restarts.get(key);
        if (quota == null || Duration.between(quota.windowStart(), now).compareTo(quotaWindow) >= 0) {
            return new Quota(now, 0);
        }
        return quota;
    }

    /**
     * Releases only {@code key}'s own grant — the window stays open while any
     * other key's grant is still active (finding M1; see the class javadoc).
     */
    public synchronized void stop(String key) {
        grants.remove(key);
    }

    public synchronized boolean isActive() {
        Instant now = Instant.now();
        prune(now);
        return !grants.isEmpty();
    }

    /** Drops lapsed grants and elapsed quota windows, so neither map grows without bound. */
    private void prune(Instant now) {
        grants.values().removeIf(until -> !until.isAfter(now));
        restarts.entrySet().removeIf(e -> Duration.between(e.getValue().windowStart(), now).compareTo(quotaWindow) >= 0);
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

    /** The window is open while any grant is live; the countdown is to the latest of them. */
    public synchronized PollingStatus status() {
        Instant now = Instant.now();
        prune(now);
        Instant until = grants.values().stream().max(Comparator.naturalOrder()).orElse(null);
        boolean active = until != null;
        long secondsRemaining = active ? Duration.between(now, until).toSeconds() : 0;
        return new PollingStatus(active, secondsRemaining);
    }
}
