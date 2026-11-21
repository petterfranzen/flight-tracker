import type { AppStore } from "./state/appState";
import { fetchLiveCount } from "./api/flightApi";

/**
 * The fetch cycle: the timers that pace the map's polling window and its
 * viewport requests, split out of boot() with their comments.
 *
 * Inert at construction: nothing is timed or fetched until `restart()` (boot's
 * "generation 0") or `start()` (the Resume button). Everything it needs from
 * boot()'s closure — the store, the viewport request and whether one is in
 * flight, the poll-window restart — arrives through deps as arrow callbacks, so
 * this module keeps no import of main.ts.
 */
export interface FetchCycleDeps {
  store: AppStore;
  /** The viewport request the debounce and the overview cadence drive. */
  fetchViewport: () => void;
  /** True while a viewport request is in flight (its response has not landed). */
  viewportInFlight: () => boolean;
  /** True while the map is zoomed out to the overview (below the individual-marker threshold). */
  zoomedOut: () => boolean;
  /** Reopen the backend's poll window (the Resume button; never a timer). */
  restartPolling: () => Promise<unknown>;
  /** How long the view must sit still before a viewport request. */
  viewportDebounceMs: number;
  /** The poll tick (shared with the selected plane's priority poll). */
  fetchIntervalMs: number;
  /** How long the watch window runs before the cycle's own timers stop. */
  fetchStopMs: number;
  /** Zoomed out, the overview gets no live pushes, so it is refetched on this cadence. */
  overviewRefreshMs: number;
  /** When the Resume dialog appears, measured from the window's start. */
  dialogStopMs: number;
}

export interface FetchCycle {
  /** A viewport change: request now (immediate) or after the debounce. */
  scheduleViewportFetch: (immediate: boolean) => void;
  /** Drop a debounce that is still pending — the view it was for no longer exists. */
  cancelViewportFetch: () => void;
  /** The watch window is over: stop every cycle timer. */
  stop: () => void;
  /** (Re)start the cycle timers from the current window start. */
  restart: () => void;
  /** The Resume button. */
  start: () => void;
}

export function createFetchCycle(deps: FetchCycleDeps): FetchCycle {
  const { store, viewportDebounceMs, fetchIntervalMs, fetchStopMs, overviewRefreshMs, dialogStopMs } = deps;

  let cycleStart = Date.now();
  let fetchIntervalTimer: ReturnType<typeof setInterval> | null = null;
  let overviewTimer: ReturnType<typeof setInterval> | null = null;
  let dialogTimer: ReturnType<typeof setTimeout> | null = null;
  let viewportFetchTimer: ReturnType<typeof setTimeout> | null = null;

  function fetchFreshData(): void {
    fetchLiveCount()
      .then((n) => store.set("trackedCount", n))
      .catch(() => {});
    fetchLiveCount(false)
      .then((n) => store.set("seenCount", n))
      .catch(() => {});
    // A viewport request still in flight (or about to fire) already covers
    // this tick — don't stack a second one on top of it.
    if (deps.viewportInFlight() || viewportFetchTimer) return;
    deps.fetchViewport();
  }

  function stopFetchIntervalTimer(): void {
    if (fetchIntervalTimer) clearInterval(fetchIntervalTimer);
    fetchIntervalTimer = null;
  }

  function stopOverviewTimer(): void {
    if (overviewTimer) clearInterval(overviewTimer);
    overviewTimer = null;
  }

  function stop(): void {
    stopFetchIntervalTimer();
    stopOverviewTimer();
    if (dialogTimer) clearTimeout(dialogTimer);
    dialogTimer = null;
  }

  /** The watch window has run out: each cycle timer clears itself at this point. */
  function windowExpired(): boolean {
    return Date.now() - cycleStart >= fetchStopMs;
  }

  function startFetchIntervalTimer(): void {
    stopFetchIntervalTimer();
    fetchIntervalTimer = setInterval(() => {
      if (windowExpired()) {
        stopFetchIntervalTimer();
        return;
      }
      fetchFreshData();
    }, fetchIntervalMs);
  }

  /** Zoomed out and visible, with no viewport request in flight or about to fire. */
  function overviewDue(): boolean {
    if (!deps.zoomedOut()) return false;
    if (document.hidden) return false;
    if (deps.viewportInFlight()) return false;
    return !viewportFetchTimer;
  }

  function startOverviewTimer(): void {
    stopOverviewTimer();
    overviewTimer = setInterval(() => {
      if (windowExpired()) {
        stopOverviewTimer();
        return;
      }
      if (overviewDue()) deps.fetchViewport();
    }, overviewRefreshMs);
  }

  function scheduleResumeDialog(): void {
    // At the end of the watch window, ask — don't silently reopen the
    // backend's poll window. /api/agents/restart is called from exactly two
    // places: page load (only if the window is closed) and the Resume
    // button (startCycle). Never from a timer, a reconnect or an error path.
    if (dialogTimer) clearTimeout(dialogTimer);
    const dialogDelay = dialogStopMs - (Date.now() - cycleStart);
    dialogTimer = setTimeout(() => {
      stop();
      store.set("showResumeDialog", true);
    }, dialogDelay);
  }

  function restart(): void {
    startFetchIntervalTimer();
    startOverviewTimer();
    scheduleResumeDialog();
  }

  /** The Resume button. */
  function start(): void {
    cycleStart = Date.now();
    store.set("showResumeDialog", false);
    deps.restartPolling().catch(() => {});
    fetchFreshData();
    restart();
  }

  function scheduleViewportFetch(immediate: boolean): void {
    if (viewportFetchTimer) clearTimeout(viewportFetchTimer);
    viewportFetchTimer = null;
    if (immediate) deps.fetchViewport();
    else viewportFetchTimer = setTimeout(deps.fetchViewport, viewportDebounceMs);
  }

  function cancelViewportFetch(): void {
    if (viewportFetchTimer) clearTimeout(viewportFetchTimer);
    viewportFetchTimer = null;
  }

  return { scheduleViewportFetch, cancelViewportFetch, stop, restart, start };
}
