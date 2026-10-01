import { Store } from "./state/store";
import type { AppState } from "./state/appState";
import { h, clear } from "./ui/h";
import { loadTheme, saveTheme } from "./theme";
import type { Theme } from "./theme";
import type { FavoriteAircraft, FavoriteRoute } from "./favorites";
import { loadFavoriteAircraft, loadFavoriteRoutes, toggleFavoriteAircraft, toggleFavoriteRoute } from "./favorites";
import type { AirportSelection, Bounds, ClusterPoint, FlightPosition, LiveMarker, SelectedPosition } from "./types/flight";
import {
  fetchAircraftDossier,
  fetchAirportInfo,
  fetchFlightLive,
  fetchHistory,
  fetchLiveClusters,
  fetchLiveCount,
  fetchLivePositions,
  fetchPollingStatus,
  restartPolling,
  subscribeLiveFeed,
} from "./api/flightApi";
import { boundsFromMap, createFollowSelected, createMap } from "./map/map";
import { createMarkerLayer } from "./map/markers";
import { clusterPositions, createClusterLayer, gridDegForZoom } from "./map/clusters";
import { createRouteLayer } from "./map/route";
import { snapBounds, ViewCache, type CachedView } from "./map/viewCache";
import * as scaleBar from "./ui/scaleBar";
import * as dock from "./ui/dock";
import * as flightSearch from "./ui/flightSearch";
import * as favoritesPanel from "./ui/favoritesPanel";
import * as legend from "./ui/legend";
import * as themeToggle from "./ui/themeToggle";
import * as dossierPanel from "./ui/dossierPanel";
import * as bootScreen from "./ui/bootScreen";
import * as resumeDialog from "./ui/resumeDialog";
import "./components/FlightMap.css"; // app-shell/header/dock/details-panel/tracked-chip/resume-dialog styles — kept unchanged

// See the comment block above FETCH_INTERVAL_MS in the original FlightMap.tsx
// for the full "watch lifecycle" picture this drives.
const FETCH_INTERVAL_MS = 72_000;
const FETCH_STOP_MS = 5 * 60_000;
const DIALOG_STOP_MS = 5 * 60_000;

// Below this zoom, the map switches to aggregated cluster bubbles instead
// of individual aircraft markers (server-side).
const CLUSTER_FETCH_MAX_ZOOM = 8;
// Client-side backstop for an individual-marker zoom that's still too busy.
const MAX_INDIVIDUAL_MARKERS = 500;

// A drag or wheel-zoom fires a burst of moveends; only the one the user
// settles on is worth a request.
const VIEWPORT_DEBOUNCE_MS = 250;
// WebSocket pushes arrive one aircraft per frame — hundreds to thousands per
// poll cycle. They're coalesced (latest per icao24) and applied in one
// render at most this often, instead of one full re-render per frame.
const WS_FLUSH_MS = 250;
// Matches .plane-icon's opacity transition (FlightMap.css): how long the
// "exiting" fade gets before markers are actually dropped on zoom-out.
const EXIT_FADE_MS = 300;

// View cache (map/viewCache.ts): a cached view this fresh is shown without
// asking the server again; older but still usable ones are shown at once
// and revalidated in the background; past VIEW_CACHE_MAX_AGE_MS they're
// not shown at all.
const VIEW_CACHE_FRESH_MS = 15_000;
// Individual positions go stale much faster than cluster counts: a cached
// /live view is still drawn at once, but older than this it's re-fetched
// in the background so markers correct within one round trip.
const LIVE_CACHE_FRESH_MS = 3_000;
const VIEW_CACHE_MAX_AGE_MS = 5 * 60_000;
const VIEW_CACHE_MAX_ENTRIES = 40;

// FlightController.liveClusters clamps gridDeg to this range; snapping the
// request to the grid the server actually uses keeps every cell complete.
function serverGridDeg(zoom: number): number {
  return Math.min(25, Math.max(0.5, gridDegForZoom(zoom)));
}

// Fraction of the view's size drawn beyond each edge.
const RENDER_MARGIN = 0.2;

function padBounds(b: Bounds, fraction: number): Bounds {
  const dLat = (b.latMax - b.latMin) * fraction;
  const dLon = (b.lonMax - b.lonMin) * fraction;
  return { latMin: b.latMin - dLat, latMax: b.latMax + dLat, lonMin: b.lonMin - dLon, lonMax: b.lonMax + dLon };
}

function inBounds(b: Bounds, lat: number, lon: number): boolean {
  return lat >= b.latMin && lat <= b.latMax && lon >= b.lonMin && lon <= b.lonMax;
}

function isNewer(a: { observedAt: string }, b: { observedAt: string }): boolean {
  return a.observedAt > b.observedAt;
}

function boot(): void {
  const rootEl = document.getElementById("root");
  if (!rootEl) throw new Error("#root not found");

  // ---- DOM skeleton (mirrors the original FlightMap.tsx JSX order; no
  // CSS in this app depends on direct-child/sibling combinators, so the
  // extra per-module wrapper divs below are free). ----
  const appShell = h("div", { className: "app-shell" });
  const bootScreenRoot = h("div");
  const dockRoot = h("div");
  const leftOverlayStack = h("div", { className: "left-overlay-stack" });
  const trackedChipRoot = h("div");
  const resumeDialogRoot = h("div");
  const mapRoot = h("div");
  const dossierRoot = h("div");
  appShell.append(bootScreenRoot, dockRoot, leftOverlayStack, trackedChipRoot, resumeDialogRoot, mapRoot, dossierRoot);
  rootEl.appendChild(appShell);

  leftOverlayStack.appendChild(
    h("header", { className: "app-header" }, h("h1", null, "Netwatch Skygrid"), h("p", { className: "app-header-subtitle" }, "Live aircraft positions")),
  );

  // ---- store ----
  const initialTheme = loadTheme();
  const state: AppState = {
    theme: initialTheme,
    zoom: 6,
    trackedCount: 0,
    firstLoadDone: false,
    basemapReady: initialTheme !== "cyberpunk",
    showResumeDialog: false,

    selectedId: null,
    selectedPos: null,
    selectedPosFresh: false,
    dossier: null,
    dossierExpanded: false,
    planeOffScreen: false,
    focusRequest: 0,
    nowMs: Date.now(),

    airportDossier: null,
    airportInfo: null,

    favoriteRoutes: loadFavoriteRoutes(),
    favoriteAircraft: loadFavoriteAircraft(),

    // Placeholders — replaced with real closures below once every module
    // they need (map, layers) exists. Never called before that happens:
    // nothing synchronous between here and the store.set() calls below
    // reaches user interaction.
    selectAircraft: () => {},
    selectAirport: () => {},
    closeAircraftPanel: () => {},
    closeAirportPanel: () => {},
    toggleDossierExpanded: () => {},
    requestFocusPlane: () => {},
    toggleAircraftFavorite: () => {},
    toggleRouteFavorite: () => {},
    removeFavoriteAircraft: () => {},
    removeFavoriteRoute: () => {},
    toggleTheme: () => {},
    resumeTracking: () => {},
  };
  const store = new Store<AppState>(state);

  // ---- local mutable state (the original's useRef/useState-outside-store) ----
  // Only ever holds the aircraft in the current individual-marker viewport
  // (zoom >= CLUSTER_FETCH_MAX_ZOOM) plus the selected one — never "every
  // aircraft we've heard about". Mutated in place: copying it per update
  // was O(n) per WebSocket frame.
  const positions = new Map<string, LiveMarker>();
  let clusters: ClusterPoint[] = [];

  let cycleStart = Date.now();
  let fetchIntervalTimer: ReturnType<typeof setInterval> | null = null;
  let dialogTimer: ReturnType<typeof setTimeout> | null = null;

  let bounds: Bounds | null = null;
  let zoom = 6;
  let viewportFetchTimer: ReturnType<typeof setTimeout> | null = null;
  let viewportAbort: AbortController | null = null;
  let exitFadeTimer: ReturnType<typeof setTimeout> | null = null;
  // Whether the last render drew unselected aircraft as individual markers.
  let individualMarkersShown = false;

  // Per zoom for clusters (the grid depends on it); for individual aircraft
  // any z>=CLUSTER_FETCH_MAX_ZOOM entry whose bbox covers the view will do,
  // so zooming in is served entirely from the parent view's data.
  const clusterCache = new ViewCache<ClusterPoint[]>(VIEW_CACHE_MAX_ENTRIES, VIEW_CACHE_MAX_AGE_MS);
  const liveCache = new ViewCache<LiveMarker[]>(VIEW_CACHE_MAX_ENTRIES, VIEW_CACHE_MAX_AGE_MS);
  let lastAppliedView: CachedView<unknown> | null = null;

  const pendingWs = new Map<string, FlightPosition>();
  let wsFlushTimer: ReturnType<typeof setTimeout> | null = null;

  let route: [number, number][] = [];
  let lastRouteObservedAt: string | null = null;
  let routePoints: { lat: number; lon: number; observedAt: string }[] = [];
  let legStartAt: string | null = null;
  let selectionEffectSeq = 0;

  let nowMsTimer: ReturnType<typeof setInterval> | null = null;
  let priorityPollTimer: ReturnType<typeof setInterval> | null = null;

  // ---- route ----
  function appendRoutePoint(p: LiveMarker): void {
    // Strictly-older only, not <=: the server can report an updated
    // position for the same last-known fix without observedAt itself
    // advancing (a dead-reckoned estimate projected further forward).
    if (lastRouteObservedAt != null && p.observedAt < lastRouteObservedAt) return;
    lastRouteObservedAt = p.observedAt;
    const last = routePoints[routePoints.length - 1];
    if (last && last.lat === p.latitude && last.lon === p.longitude) return;
    routePoints = [...routePoints, { lat: p.latitude, lon: p.longitude, observedAt: p.observedAt }];
    route = [...route, [p.latitude, p.longitude]];
    routeLayer.update(route);
  }

  // ---- aircraft/cluster rendering ----
  function renderAircraftLayer(): void {
    const selectedId = store.get("selectedId");
    const selectedPos = store.get("selectedPos");
    // Only what's on screen (plus a margin, so a short drag doesn't reveal
    // empty edges before moveend re-renders). `positions` can hold a wider
    // area than the view — a cached parent view when zooming in — and the
    // MAX_INDIVIDUAL_MARKERS decision has to be about what's visible.
    const view = bounds ? padBounds(bounds, RENDER_MARGIN) : null;
    const list = Array.from(positions.values()).filter((p) => !view || inBounds(view, p.latitude, p.longitude));
    const unselectedList = selectedId ? list.filter((p) => p.icao24 !== selectedId) : list;

    const belowServerClusterZoom = zoom < CLUSTER_FETCH_MAX_ZOOM;
    const clientClustered = !belowServerClusterZoom && unselectedList.length > MAX_INDIVIDUAL_MARKERS;

    if (belowServerClusterZoom) clusterLayer.update(clusters);
    else if (clientClustered) clusterLayer.update(clusterPositions(unselectedList, gridDegForZoom(zoom)));
    else clusterLayer.update([]);

    // Below the cluster zoom, unselected markers only get the "exiting"
    // fade if they were actually on screen as individual markers. Coming
    // from a client-clustered view they never were, and handing the whole
    // list over built every one of them (1,000+ DOM markers, each with
    // its own fade-in animation) just to fade it straight back out — a
    // ~1s main-thread stall on every zoom-out from a busy area.
    const showIndividually = belowServerClusterZoom ? individualMarkersShown : !clientClustered;
    // Stays true below the cluster zoom until the fade finishes (see
    // dropIndividualMarkersAfterFade), so a cluster fetch landing mid-fade
    // doesn't cut it short.
    if (!belowServerClusterZoom) individualMarkersShown = !clientClustered;

    markerLayer.update({
      unselected: showIndividually ? unselectedList : [],
      selectedPos,
      zoom,
      exiting: belowServerClusterZoom,
    });
  }

  // ---- fetch lifecycle ----
  function applyLiveSnapshot(list: LiveMarker[]): void {
    const selectedId = store.get("selectedId");
    const selectedKept = selectedId ? positions.get(selectedId) : undefined;
    const previous = new Map(positions);
    positions.clear();
    for (const p of list) {
      const existing = previous.get(p.icao24);
      positions.set(p.icao24, existing && isNewer(existing, p) ? existing : p);
    }
    // The selected aircraft stays even if it just left the viewport — its
    // own priority poll keeps it current.
    if (selectedKept && !positions.has(selectedKept.icao24)) positions.set(selectedKept.icao24, selectedKept);
    renderAircraftLayer();
    const current = selectedId ? positions.get(selectedId) : null;
    if (current) {
      const prev = store.get("selectedPos");
      store.set("selectedPos", prev ? { ...prev, ...current } : { ...current, altitudeM: null, velocityMs: null, verticalRateMs: null });
      appendRoutePoint(current);
    }
  }

  function findCachedView(now: number): CachedView<ClusterPoint[]> | CachedView<LiveMarker[]> | null {
    if (!bounds) return null;
    return zoom < CLUSTER_FETCH_MAX_ZOOM
      ? clusterCache.find(bounds, (z) => z === zoom, now)
      : liveCache.find(bounds, (z) => z >= CLUSTER_FETCH_MAX_ZOOM, now);
  }

  /** Draws the best cached data for the current view, if any and not already on screen. */
  function applyCachedView(now: number): CachedView<unknown> | null {
    const hit = findCachedView(now);
    if (!hit || hit === lastAppliedView) return hit;
    lastAppliedView = hit;
    if (zoom < CLUSTER_FETCH_MAX_ZOOM) {
      clusters = hit.data as ClusterPoint[];
      renderAircraftLayer();
    } else {
      applyLiveSnapshot(hit.data as LiveMarker[]);
    }
    return hit;
  }

  /**
   * The one place viewport data is requested. Below CLUSTER_FETCH_MAX_ZOOM
   * that's server-side clusters only — never /live, whose size grows with
   * the whole tracked fleet; at or above it, /live for exactly the current
   * viewport (deliberately unpadded: its bbox is what the OpenSky hot poll
   * covers, and a bigger area costs more credits). Cached views are drawn
   * first (see ViewCache) and a fresh one skips the request entirely. One
   * request at a time: a newer viewport aborts the one in flight, and a
   * poll tick that finds one in flight skips (see fetchFreshData), so
   * requests never overlap or land out of order.
   */
  function fetchViewport(): void {
    if (viewportFetchTimer) clearTimeout(viewportFetchTimer);
    viewportFetchTimer = null;
    if (!bounds) return;
    const now = Date.now();
    const hit = applyCachedView(now);
    const freshFor = zoom < CLUSTER_FETCH_MAX_ZOOM ? VIEW_CACHE_FRESH_MS : LIVE_CACHE_FRESH_MS;
    if (hit && now - hit.fetchedAt < freshFor) {
      store.set("firstLoadDone", true);
      return;
    }
    viewportAbort?.abort();
    const controller = new AbortController();
    viewportAbort = controller;
    const requestZoom = zoom;
    const done = (): void => {
      if (viewportAbort === controller) viewportAbort = null;
      store.set("firstLoadDone", true);
    };
    if (requestZoom < CLUSTER_FETCH_MAX_ZOOM) {
      const grid = serverGridDeg(requestZoom);
      const requestBounds = snapBounds(bounds, grid * 2);
      fetchLiveClusters(requestBounds, grid, controller.signal)
        .then((c) => {
          const entry = { zoom: requestZoom, bbox: requestBounds, data: c, fetchedAt: Date.now() };
          clusterCache.put(entry);
          if (controller.signal.aborted || zoom !== requestZoom) return;
          lastAppliedView = entry;
          clusters = c;
          renderAircraftLayer();
        })
        .catch(() => {})
        .finally(done);
      return;
    }
    const requestBounds = bounds;
    fetchLivePositions(requestBounds, controller.signal)
      .then((list) => {
        const entry = { zoom: requestZoom, bbox: requestBounds, data: list, fetchedAt: Date.now() };
        liveCache.put(entry);
        if (controller.signal.aborted || zoom < CLUSTER_FETCH_MAX_ZOOM) return;
        lastAppliedView = entry;
        applyLiveSnapshot(list);
      })
      .catch(() => {})
      .finally(done);
  }

  function fetchFreshData(): void {
    fetchLiveCount()
      .then((n) => store.set("trackedCount", n))
      .catch(() => {});
    // A viewport request still in flight (or about to fire) already covers
    // this tick — don't stack a second one on top of it.
    if (viewportAbort || viewportFetchTimer) return;
    fetchViewport();
  }

  function handleViewportChange(nextBounds: Bounds, nextZoom: number, immediate = false): void {
    const wasClustered = zoom < CLUSTER_FETCH_MAX_ZOOM;
    bounds = nextBounds;
    zoom = nextZoom;
    store.set("zoom", nextZoom);
    const clustered = nextZoom < CLUSTER_FETCH_MAX_ZOOM;
    if (clustered !== wasClustered) {
      clusters = [];
      lastAppliedView = null;
    }
    if (clustered && !wasClustered) dropIndividualMarkersAfterFade();
    if (!clustered && exitFadeTimer) {
      clearTimeout(exitFadeTimer);
      exitFadeTimer = null;
    }
    renderAircraftLayer(); // icon sizes/cluster mode update for the new zoom immediately, independent of the fetch below
    // A view we've seen recently is drawn right away, before the debounce.
    applyCachedView(Date.now());

    // Whatever is in flight was for a viewport that no longer exists.
    viewportAbort?.abort();
    viewportAbort = null;
    if (viewportFetchTimer) clearTimeout(viewportFetchTimer);
    viewportFetchTimer = null;
    if (immediate) fetchViewport();
    else viewportFetchTimer = setTimeout(fetchViewport, VIEWPORT_DEBOUNCE_MS);
  }

  // Zoomed out past CLUSTER_FETCH_MAX_ZOOM: the individual markers fade
  // (renderAircraftLayer marks them exiting), then go — they used to stay
  // in `positions` and the DOM, invisible, for the rest of the session,
  // and every later render walked all of them.
  function dropIndividualMarkersAfterFade(): void {
    if (exitFadeTimer) clearTimeout(exitFadeTimer);
    exitFadeTimer = setTimeout(() => {
      exitFadeTimer = null;
      if (zoom >= CLUSTER_FETCH_MAX_ZOOM) return;
      const selectedId = store.get("selectedId");
      for (const id of Array.from(positions.keys())) if (id !== selectedId) positions.delete(id);
      individualMarkersShown = false;
      renderAircraftLayer();
    }, EXIT_FADE_MS);
  }

  // ---- live push feed ----
  // Updates are kept for everything renderAircraftLayer draws: the view plus
  // its RENDER_MARGIN. Filtering to the bare view left aircraft in the
  // margin frozen at their last snapshot, so a pan brought them on screen
  // at old positions.
  function inDrawnArea(p: LiveMarker): boolean {
    if (zoom < CLUSTER_FETCH_MAX_ZOOM || !bounds) return false;
    return inBounds(padBounds(bounds, RENDER_MARGIN), p.latitude, p.longitude);
  }

  function onLivePush(p: FlightPosition): void {
    // The server filters by the last viewport *anyone* reported (one shared
    // viewport, see ViewportService) — keep only what this map is showing
    // as individual markers, plus the selected aircraft.
    const isSelected = p.icao24 === store.get("selectedId");
    if (!isSelected && !inDrawnArea(p)) return;
    const queued = pendingWs.get(p.icao24);
    if (queued && !isNewer(p, queued)) return;
    pendingWs.set(p.icao24, p);
    if (!wsFlushTimer) wsFlushTimer = setTimeout(flushLivePushes, WS_FLUSH_MS);
  }

  function flushLivePushes(): void {
    wsFlushTimer = null;
    if (pendingWs.size === 0) return;
    const selectedId = store.get("selectedId");
    let selectedUpdate: FlightPosition | null = null;
    let changed = false;
    for (const p of pendingWs.values()) {
      const existing = positions.get(p.icao24);
      if (existing && !isNewer(p, existing)) continue; // superseded by a /live reconcile already
      if (p.icao24 !== selectedId && !inDrawnArea(p)) continue;
      positions.set(p.icao24, p);
      changed = true;
      if (p.icao24 === selectedId) selectedUpdate = p;
    }
    pendingWs.clear();
    if (changed) renderAircraftLayer();
    if (selectedUpdate) {
      store.set("selectedPos", selectedUpdate);
      store.set("selectedPosFresh", true);
      appendRoutePoint(selectedUpdate);
    }
  }

  function stopFetchCycle(): void {
    if (fetchIntervalTimer) clearInterval(fetchIntervalTimer);
    fetchIntervalTimer = null;
    if (dialogTimer) clearTimeout(dialogTimer);
    dialogTimer = null;
  }

  function restartFetchCycleTimers(): void {
    if (fetchIntervalTimer) clearInterval(fetchIntervalTimer);
    fetchIntervalTimer = setInterval(() => {
      if (Date.now() - cycleStart >= FETCH_STOP_MS) {
        if (fetchIntervalTimer) clearInterval(fetchIntervalTimer);
        fetchIntervalTimer = null;
        return;
      }
      fetchFreshData();
    }, FETCH_INTERVAL_MS);

    // At the end of the watch window, ask — don't silently reopen the
    // backend's poll window. /api/agents/restart is called from exactly two
    // places: page load (only if the window is closed) and the Resume
    // button (startCycle). Never from a timer, a reconnect or an error path.
    if (dialogTimer) clearTimeout(dialogTimer);
    const dialogDelay = DIALOG_STOP_MS - (Date.now() - cycleStart);
    dialogTimer = setTimeout(() => {
      stopFetchCycle();
      store.set("showResumeDialog", true);
    }, dialogDelay);
  }

  /** The Resume button. */
  function startCycle(): void {
    cycleStart = Date.now();
    store.set("showResumeDialog", false);
    restartPolling().catch(() => {});
    fetchFreshData();
    restartFetchCycleTimers();
  }

  // ---- per-selection lifecycle (history/dossier fetch, priority poll, "now" ticker) ----
  function stopPriorityPoll(): void {
    if (priorityPollTimer) clearInterval(priorityPollTimer);
    priorityPollTimer = null;
  }
  function startPriorityPoll(icao24: string): void {
    let inFlight = false;
    function poll(): void {
      if (inFlight) return; // never overlap with a slow previous poll
      inFlight = true;
      fetchFlightLive(icao24)
        .then((p) => {
          if (!p || p.icao24 !== store.get("selectedId")) return;
          const existing = positions.get(p.icao24);
          // A newer live push may have beaten this response; either way the
          // selection now has a server position from after it was made.
          const best = existing && isNewer(existing, p) ? existing : p;
          positions.set(best.icao24, best);
          const prev = store.get("selectedPos");
          store.set("selectedPos", prev && prev.icao24 === best.icao24 ? { ...prev, ...best } : { ...best, altitudeM: null, velocityMs: null, verticalRateMs: null });
          store.set("selectedPosFresh", true);
          appendRoutePoint(best);
          renderAircraftLayer();
        })
        .catch(() => {})
        .finally(() => {
          inFlight = false;
        });
    }
    poll();
    priorityPollTimer = setInterval(poll, FETCH_INTERVAL_MS);
  }

  function stopNowMsTicker(): void {
    if (nowMsTimer) clearInterval(nowMsTimer);
    nowMsTimer = null;
  }
  function startNowMsTicker(): void {
    store.set("nowMs", Date.now());
    nowMsTimer = setInterval(() => store.set("nowMs", Date.now()), 1_000);
  }

  function onSelectedIdChanged(): void {
    const seq = ++selectionEffectSeq;
    stopPriorityPoll();
    stopNowMsTicker();

    // Cleared unconditionally: switching directly from aircraft A to B
    // never passes through "selected = null".
    route = [];
    lastRouteObservedAt = null;
    routePoints = [];
    legStartAt = null;
    routeLayer.update(route);

    const selectedId = store.get("selectedId");
    if (!selectedId) {
      store.set("dossier", null);
      store.set("selectedPos", null);
      return;
    }

    startNowMsTicker();
    startPriorityPoll(selectedId);

    const to = new Date().toISOString();
    const from = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(); // last 6h of history
    fetchHistory(selectedId, from, to).then((track) => {
      if (seq !== selectionEffectSeq) return; // superseded by a newer selection
      const filtered = legStartAt ? track.filter((p) => p.observedAt >= legStartAt!) : track;
      if (filtered.length > 0) lastRouteObservedAt = filtered[filtered.length - 1].observedAt;
      routePoints = filtered.map((p) => ({ lat: p.latitude, lon: p.longitude, observedAt: p.observedAt }));
      route = filtered.map((p): [number, number] => [p.latitude, p.longitude]);
      routeLayer.update(route);
      const currentSelectedPos = store.get("selectedPos");
      if (currentSelectedPos) appendRoutePoint(currentSelectedPos);
    });

    store.set("dossier", null); // clear the previous aircraft's fields while the new lookup is in flight
    fetchAircraftDossier(selectedId)
      .then((d) => {
        if (seq !== selectionEffectSeq) return;
        store.set("dossier", d);
        legStartAt = d?.legStartAt ?? null;
        if (legStartAt) {
          const trimmed = routePoints.filter((pt) => pt.observedAt >= legStartAt!);
          if (trimmed.length !== routePoints.length) {
            routePoints = trimmed;
            route = trimmed.map((pt): [number, number] => [pt.lat, pt.lon]);
            routeLayer.update(route);
          }
        }
      })
      .catch(() => {
        if (seq === selectionEffectSeq) store.set("dossier", null);
      });
  }

  // ---- selection actions ----
  // How long a new selection waits for a fresh server position before the
  // map flies to the (possibly stale) one it was selected with anyway.
  const FRESH_POSITION_WAIT_MS = 1_500;
  let freshWaitTimer: ReturnType<typeof setTimeout> | null = null;

  function handleSelectAircraft(selected: LiveMarker): void {
    // Lists (favourites, search results) hand over the position they last
    // fetched, which can be many seconds old; the map flies only once a
    // fresh one arrives (the priority poll starts on selection, or a live
    // push lands first) — or after FRESH_POSITION_WAIT_MS regardless.
    const known = positions.get(selected.icao24);
    const p = known && isNewer(known, selected) ? known : selected;
    if (p.icao24 !== store.get("selectedId")) {
      store.set("selectedPosFresh", false);
      if (freshWaitTimer) clearTimeout(freshWaitTimer);
      freshWaitTimer = setTimeout(() => {
        if (store.get("selectedId") === p.icao24) store.set("selectedPosFresh", true);
      }, FRESH_POSITION_WAIT_MS);
    }
    store.set("airportDossier", null);
    store.set("selectedId", p.icao24); // no-op (and no effect re-run) if already selected — matches the original's state bail-out
    const prevSelectedPos = store.get("selectedPos");
    store.set("selectedPos", prevSelectedPos && prevSelectedPos.icao24 === p.icao24 ? { ...prevSelectedPos, ...p } : { ...p, altitudeM: null, velocityMs: null, verticalRateMs: null });
    store.set("dossierExpanded", false);
  }
  function handleSelectAirport(ap: AirportSelection): void {
    store.set("selectedId", null);
    store.set("airportDossier", ap);
    store.set("airportInfo", null);
    store.set("dossierExpanded", false);
    fetchAirportInfo(ap.code)
      .then((info) => store.set("airportInfo", info))
      .catch(() => {});
  }
  function closeAircraftPanel(): void {
    store.set("selectedId", null);
  }
  function closeAirportPanel(): void {
    store.set("airportDossier", null);
  }
  function toggleDossierExpanded(): void {
    store.update("dossierExpanded", (v) => !v);
  }
  function requestFocusPlane(): void {
    store.update("focusRequest", (n) => n + 1);
  }

  // ---- favorites ----
  function toggleAircraftFavorite(): void {
    const selectedPos = store.get("selectedPos");
    if (!selectedPos) return;
    const dossier = store.get("dossier");
    store.set(
      "favoriteAircraft",
      toggleFavoriteAircraft(store.get("favoriteAircraft"), {
        icao24: selectedPos.icao24,
        registration: dossier?.registration ?? null,
        callsign: selectedPos.callsign,
      }),
    );
  }
  function toggleRouteFavorite(): void {
    const dossier = store.get("dossier");
    if (!dossier?.originAirport || !dossier?.destinationAirport) return;
    store.set(
      "favoriteRoutes",
      toggleFavoriteRoute(store.get("favoriteRoutes"), {
        origin: dossier.originAirport,
        originName: dossier.originAirportName,
        originIata: dossier.originAirportIata,
        destination: dossier.destinationAirport,
        destinationName: dossier.destinationAirportName,
        destinationIata: dossier.destinationAirportIata,
      }),
    );
  }
  function removeFavoriteAircraft(entry: FavoriteAircraft): void {
    store.set("favoriteAircraft", toggleFavoriteAircraft(store.get("favoriteAircraft"), entry));
  }
  function removeFavoriteRoute(favRoute: FavoriteRoute): void {
    store.set("favoriteRoutes", toggleFavoriteRoute(store.get("favoriteRoutes"), favRoute));
  }

  // ---- map + layers ----
  const mapController = createMap(mapRoot, initialTheme, handleViewportChange, (ready) => store.set("basemapReady", ready));
  const map = mapController.map;
  const markerLayer = createMarkerLayer(map, handleSelectAircraft);
  const clusterLayer = createClusterLayer(map);
  const routeLayer = createRouteLayer(map);
  const followSelected = createFollowSelected(map, (offScreen) => store.set("planeOffScreen", offScreen));

  function toggleTheme(): void {
    const next: Theme = store.get("theme") === "cyberpunk" ? "default" : "cyberpunk";
    saveTheme(next);
    store.set("theme", next);
    mapController.setTheme(next);
  }

  // ---- wire real actions into the store now that every closure above exists ----
  store.set("selectAircraft", handleSelectAircraft);
  store.set("selectAirport", handleSelectAirport);
  store.set("closeAircraftPanel", closeAircraftPanel);
  store.set("closeAirportPanel", closeAirportPanel);
  store.set("toggleDossierExpanded", toggleDossierExpanded);
  store.set("requestFocusPlane", requestFocusPlane);
  store.set("toggleAircraftFavorite", toggleAircraftFavorite);
  store.set("toggleRouteFavorite", toggleRouteFavorite);
  store.set("removeFavoriteAircraft", removeFavoriteAircraft);
  store.set("removeFavoriteRoute", removeFavoriteRoute);
  store.set("toggleTheme", toggleTheme);
  store.set("resumeTracking", startCycle);

  // ---- UI modules ----
  scaleBar.mount(map);
  import("./ui/defaultAirports").then((mod) => mod.mount(map, handleSelectAirport));

  flightSearch.mount(leftOverlayStack, store);
  favoritesPanel.mount(leftOverlayStack, store);
  legend.mount(leftOverlayStack); // no store slots — its open/closed state is purely local (see ui/legend.ts)
  themeToggle.mount(leftOverlayStack, store);
  bootScreen.mount(bootScreenRoot, store);
  resumeDialog.mount(resumeDialogRoot, store);
  dossierPanel.mount(dossierRoot, store);

  // Dock: hidden whenever either details panel is open — a real
  // mount/unmount (not a CSS hide) to match the original's conditional JSX.
  let dockUnmount: (() => void) | null = null;
  function syncDock(): void {
    const shouldShow = !store.get("selectedPos") && !store.get("airportDossier");
    if (shouldShow && !dockUnmount) dockUnmount = dock.mount(dockRoot);
    else if (!shouldShow && dockUnmount) {
      dockUnmount();
      dockUnmount = null;
    }
  }
  store.subscribeMany(["selectedPos", "airportDossier"], syncDock);
  syncDock();

  // Tracked-chip: cyberpunk-only, inline (not a separate component in the
  // original either).
  function renderTrackedChip(): void {
    clear(trackedChipRoot);
    if (store.get("theme") !== "cyberpunk") return;
    trackedChipRoot.appendChild(
      h(
        "div",
        { className: "tracked-chip" },
        h("span", { className: "tracked-chip-dot", "aria-hidden": "true" }),
        h("span", { className: "tracked-chip-label" }, "Tracked"),
        h("span", { className: "tracked-chip-value" }, store.get("trackedCount").toLocaleString()),
      ),
    );
  }
  renderTrackedChip();
  store.subscribeMany(["theme", "trackedCount"], renderTrackedChip);

  // ---- follow-selected wiring ----
  function syncFollowSelected(): void {
    const selectedPos = store.get("selectedPos");
    followSelected.update({
      selectedId: store.get("selectedId"),
      positionId: selectedPos?.icao24 ?? null,
      positionFresh: store.get("selectedPosFresh"),
      lat: selectedPos?.latitude ?? null,
      lon: selectedPos?.longitude ?? null,
      sheetExpanded: store.get("dossierExpanded"),
      focusRequest: store.get("focusRequest"),
    });
  }
  store.subscribeMany(["selectedId", "selectedPos", "selectedPosFresh", "dossierExpanded", "focusRequest"], syncFollowSelected);

  // ---- per-selection effect wiring ----
  store.subscribe("selectedId", onSelectedIdChanged);
  onSelectedIdChanged(); // selectedId starts null — harmless initial reset

  // ---- mount-only effects ----
  // Page load is one of the two callers of /api/agents/restart (the other
  // is the Resume button) — and only when the poll window is closed.
  fetchPollingStatus()
    .then((status) => {
      if (!status.active) return restartPolling();
    })
    .catch(() => {});
  fetchLiveCount()
    .then((n) => store.set("trackedCount", n))
    .catch(() => {});

  subscribeLiveFeed(onLivePush);

  restartFetchCycleTimers(); // generation 0

  // Initial viewport report — equivalent to the original ViewportReporter's
  // own mount-time call, fired only now that every layer it can cascade
  // into (markers, clusters, route) exists.
  handleViewportChange(boundsFromMap(map), map.getZoom(), true);
}

boot();
