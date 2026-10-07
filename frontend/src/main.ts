import { Store } from "./state/store";
import type { AppState } from "./state/appState";
import { h, clear } from "./ui/h";
import type { FavoriteAircraft, FavoriteRoute } from "./favorites";
import { loadFavoriteAircraft, loadFavoriteRoutes, toggleFavoriteAircraft, toggleFavoriteRoute } from "./favorites";
import type { AirportSelection, Bounds, FlightPosition, LiveMarker, LiveOverview, SelectedPosition } from "./types/flight";
import {
  fetchAircraftDossier,
  fetchAirportInfo,
  fetchFlightLive,
  fetchHistory,
  fetchLiveClusters,
  fetchLiveOverview,
  fetchGeo,
  fetchLiveCount,
  fetchLivePositions,
  fetchPollingStatus,
  restartPolling,
  subscribeLiveFeed,
} from "./api/flightApi";
import { boundsFromMap, createFollowSelected, createMap, DEFAULT_VIEW } from "./map/map";
import { createMarkerLayer, planeBoxSize } from "./map/markers";
import { declutterCellDeg, pickNonOverlapping, type Candidate } from "./map/declutter";
import { isSmallScreen } from "./map/screen";
import { pickInitialView } from "./map/initialView";
import { getMockPlaneCount } from "./api/mockFleet";
import { agedIds, findShadowedIds, isActiveTraffic, OVERLAP_MIN_ZOOM } from "./map/staleness";
import { createRouteLayer } from "./map/route";
import { snapBounds, ViewCache, type CachedView } from "./map/viewCache";
import * as scaleBar from "./ui/scaleBar";
import * as dock from "./ui/dock";
import * as flightSearch from "./ui/flightSearch";
import * as favoritesPanel from "./ui/favoritesPanel";
import * as legend from "./ui/legend";
import * as dossierPanel from "./ui/dossierPanel";
import * as bootScreen from "./ui/bootScreen";
import * as resumeDialog from "./ui/resumeDialog";
// Self-hosted cyberpunk face (latin subset).
import "@fontsource/jetbrains-mono/latin-500.css";
import "@fontsource/jetbrains-mono/latin-600.css";
import "@fontsource/jetbrains-mono/latin-700.css";
import "./components/FlightMap.css"; // app-shell/header/dock/details-panel/tracked-chip/resume-dialog styles — kept unchanged

// See the comment block above FETCH_INTERVAL_MS in the original FlightMap.tsx
// for the full "watch lifecycle" picture this drives.
const FETCH_INTERVAL_MS = 72_000;
const FETCH_STOP_MS = 5 * 60_000;
const DIALOG_STOP_MS = 5 * 60_000;

// Below this zoom the map asks the server for a thinned-out set (one plane per
// half-icon cell, first discovered first — see fetchLiveOverview) instead of
// every aircraft in view. There are no clusters: planes whose icons would
// overlap are hidden, the first discovered one stays (map/declutter.ts).
const CLUSTER_FETCH_MAX_ZOOM = 8;

// A drag or wheel-zoom fires a burst of moveends; only the one the user
// settles on is worth a request.
const VIEWPORT_DEBOUNCE_MS = 250;
// WebSocket pushes arrive one aircraft per frame — hundreds to thousands per
// poll cycle. They're coalesced (latest per icao24) and applied in one
// render at most this often, instead of one full re-render per frame.
const WS_FLUSH_MS = 250;

// Opening view (see applyInitialView): how long boot waits for the world
// summary, and the grid it asks for (coarse: a few hundred cells at most).
const INITIAL_VIEW_TIMEOUT_MS = 1_500;
const INITIAL_SUMMARY_GRID_DEG = 5;

// View cache (map/viewCache.ts): a cached view this fresh is shown without
// asking the server again; older but still usable ones are shown at once
// and revalidated in the background; past VIEW_CACHE_MAX_AGE_MS they're
// not shown at all.
const VIEW_CACHE_FRESH_MS = 8_000;
// Zoomed out, the overview's aircraft get no live pushes (the server only
// pushes the individual-marker viewport), so it is refetched on this cadence.
const OVERVIEW_REFRESH_MS = 10_000;
// Individual positions go stale much faster than cluster counts: a cached
// /live view is still drawn at once, but older than this it's re-fetched
// in the background so markers correct within one round trip.
const LIVE_CACHE_FRESH_MS = 3_000;
const VIEW_CACHE_MAX_AGE_MS = 5 * 60_000;
const VIEW_CACHE_MAX_ENTRIES = 40;

// The most planes drawn at once. Every one is a DOM marker that a zoom step
// re-places, so this is what keeps zooming smooth (a phone has a fraction of
// a laptop's CPU). Above it, planes are spaced further apart rather than cut off.
const MAX_DRAWN_MARKERS = 300;
const MAX_DRAWN_MARKERS_SMALL_SCREEN = 150;

// How long the view must sit still before the zoom levels either side of it are
// fetched in the background, so the next zoom step is drawn from cache.
const PREFETCH_DELAY_MS = 600;

// Fraction of the view's size drawn beyond each edge.
// Wide enough that a pan or a one-level zoom-out lands on planes that are already there.
const RENDER_MARGIN = 0.4;

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
  const state: AppState = {
    zoom: 6,
    trackedCount: 0,
    seenCount: 0,
    firstLoadDone: false,
    basemapReady: false,
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
    resumeTracking: () => {},
  };
  const store = new Store<AppState>(state);

  // ---- local mutable state (the original's useRef/useState-outside-store) ----
  // Only ever holds the aircraft in the current individual-marker viewport
  // (zoom >= CLUSTER_FETCH_MAX_ZOOM) plus the selected one — never "every
  // aircraft we've heard about". Mutated in place: copying it per update
  // was O(n) per WebSocket frame.
  const positions = new Map<string, LiveMarker>();
  // Zoomed out: the thinned-out set of active aircraft the server sent (see fetchLiveOverview).
  let overviewPlanes: LiveMarker[] = [];
  const overviewIndex = new Map<string, number>(); // icao24 -> index in overviewPlanes
  function setOverviewPlanes(list: LiveMarker[]): void {
    overviewPlanes = list;
    overviewIndex.clear();
    list.forEach((p, i) => overviewIndex.set(p.icao24, i));
  }

  let cycleStart = Date.now();
  let fetchIntervalTimer: ReturnType<typeof setInterval> | null = null;
  let overviewTimer: ReturnType<typeof setInterval> | null = null;
  let dialogTimer: ReturnType<typeof setTimeout> | null = null;

  let bounds: Bounds | null = null;
  let zoom = 6;
  let viewportFetchTimer: ReturnType<typeof setTimeout> | null = null;
  let viewportAbort: AbortController | null = null;

  // Per zoom for the overview (its cell size depends on it); for individual aircraft
  // any z>=CLUSTER_FETCH_MAX_ZOOM entry whose bbox covers the view will do,
  // so zooming in is served entirely from the parent view's data.
  const clusterCache = new ViewCache<LiveOverview>(VIEW_CACHE_MAX_ENTRIES, VIEW_CACHE_MAX_AGE_MS);
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
  // The trail is the real reports (routePoints) plus, at the end, one
  // movable tip. The server dead-reckons a position forward from the last
  // real report and sends it with that report's own observedAt, so a point
  // with an unchanged observedAt is an estimate, not a new fix. Baking each
  // one into the trail (as this used to) made it run past the real track
  // whenever only polls were arriving (zoomed out, no live pushes), then
  // zigzag back when the next real report landed.
  let routeTip: [number, number] | null = null;
  function drawRoute(): void {
    route = routePoints.map((pt): [number, number] => [pt.lat, pt.lon]);
    if (routeTip) route.push(routeTip);
    routeLayer.update(route);
  }
  function appendRoutePoint(p: LiveMarker): void {
    if (lastRouteObservedAt != null && p.observedAt < lastRouteObservedAt) return;
    const last = routePoints[routePoints.length - 1];
    const sameSpot = last != null && last.lat === p.latitude && last.lon === p.longitude;
    if (lastRouteObservedAt == null || p.observedAt > lastRouteObservedAt) {
      // A new real report: it joins the trail and replaces any estimate.
      lastRouteObservedAt = p.observedAt;
      routeTip = null;
      if (!sameSpot) routePoints = [...routePoints, { lat: p.latitude, lon: p.longitude, observedAt: p.observedAt }];
    } else {
      // Same report as the trail's last: an estimate, or the report itself.
      routeTip = sameSpot ? null : [p.latitude, p.longitude];
    }
    drawRoute();
  }

  // ---- aircraft rendering ----
  function renderAircraftLayer(): void {
    const selectedId = store.get("selectedId");
    const selectedPos = store.get("selectedPos");
    const nowMs = Date.now();
    // Only what's on screen (plus a margin, so a short drag doesn't reveal
    // empty edges before moveend re-renders). `positions` can hold a wider
    // area than the view — a cached parent view when zooming in.
    const view = bounds ? padBounds(bounds, RENDER_MARGIN) : null;
    // Zoomed out the server's thinned-out overview is the source; zoomed in,
    // the viewport's /live snapshot. Each stands in for the other until its
    // own data arrives, so a zoom never blanks the map.
    const zoomedOut = zoom < CLUSTER_FETCH_MAX_ZOOM;
    const useOverview = overviewPlanes.length > 0 && (zoomedOut || positions.size === 0);
    const source = useOverview ? overviewPlanes : Array.from(positions.values());
    const inView = source.filter((p) => p.icao24 !== selectedId && (!view || inBounds(view, p.latitude, p.longitude)));
    // An aircraft with a newer one on top of it is a ghost: not drawn at all
    // (see map/staleness.ts). Only where 20 m is visible.
    const shadowed = zoom >= OVERLAP_MIN_ZOOM ? findShadowedIds(inView) : null;
    const candidates = shadowed && shadowed.size > 0 ? inView.filter((p) => !shadowed.has(p.icao24)) : inView;

    // Where two planes' icons would overlap, only the first discovered is
    // drawn; the selected one is always drawn and hides whatever is under it.
    const points: Candidate[] = candidates.map((p) => {
      const pt = map.latLngToContainerPoint([p.latitude, p.longitude]);
      return { icao24: p.icao24, x: pt.x, y: pt.y, active: isActiveTraffic(p, nowMs) };
    });
    const fixed = selectedPos ? [map.latLngToContainerPoint([selectedPos.latitude, selectedPos.longitude])] : [];
    const keep = pickNonOverlapping(points, fixed, planeBoxSize(zoom), isSmallScreen() ? MAX_DRAWN_MARKERS_SMALL_SCREEN : MAX_DRAWN_MARKERS);
    const drawn = candidates.filter((p) => keep.has(p.icao24));

    markerLayer.update({
      unselected: drawn,
      selectedPos,
      zoom,
      exiting: false,
      // Reports older than 2 h are drawn dimmed (see map/staleness.ts).
      dimmed: agedIds(drawn, nowMs),
    });
  }

  // ---- fetch lifecycle ----
  function applyLiveSnapshot(list: LiveMarker[]): void {
    if (overviewPlanes.length > 0) setOverviewPlanes([]); // the snapshot is the source from here on
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

  function findCachedView(now: number): CachedView<LiveOverview> | CachedView<LiveMarker[]> | null {
    if (!bounds) return null;
    return zoom < CLUSTER_FETCH_MAX_ZOOM
      ? clusterCache.find(bounds, (z) => z === zoom, now)
      : liveCache.find(bounds, (z) => z >= CLUSTER_FETCH_MAX_ZOOM, now);
  }

  // The overview replaces the zoomed-in snapshot: its aircraft are what is
  // drawn now, so the snapshot's are dropped (the selected one is kept).
  function applyOverview(planes: LiveMarker[]): void {
    setOverviewPlanes(planes);
    const selectedId = store.get("selectedId");
    for (const id of Array.from(positions.keys())) if (id !== selectedId) positions.delete(id);
    renderAircraftLayer();
  }

  /** Draws the best cached data for the current view, if any and not already on screen. */
  function applyCachedView(now: number): CachedView<unknown> | null {
    const hit = findCachedView(now);
    if (!hit || hit === lastAppliedView) return hit;
    lastAppliedView = hit;
    if (zoom < CLUSTER_FETCH_MAX_ZOOM) {
      applyOverview((hit.data as LiveOverview).planes);
    } else {
      applyLiveSnapshot(hit.data as LiveMarker[]);
    }
    return hit;
  }

  /**
   * The one place viewport data is requested. Below CLUSTER_FETCH_MAX_ZOOM
   * that's the thinned-out overview only — never /live, whose size grows with
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
      prefetchNeighbourOverviews();
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
      const grid = declutterCellDeg(requestZoom, planeBoxSize(requestZoom));
      const requestBounds = snapBounds(bounds, grid * 2);
      fetchLiveOverview(requestBounds, grid, controller.signal)
        .then((overview) => {
          const entry = { zoom: requestZoom, bbox: requestBounds, data: overview, fetchedAt: Date.now() };
          clusterCache.put(entry);
          if (controller.signal.aborted || zoom !== requestZoom) return;
          lastAppliedView = entry;
          applyOverview(overview.planes);
          prefetchNeighbourOverviews();
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
        prefetchNeighbourOverviews();
      })
      .catch(() => {})
      .finally(done);
  }

  // Fetches the zoomed-out overview for the zoom level either side of the one
  // on screen (when that level uses the overview), so a zoom step finds it
  // cached and draws at once. Quiet: it never touches what is on screen, is
  // dropped the moment the viewport changes, and skips a level that is cached.
  let prefetchTimer: ReturnType<typeof setTimeout> | null = null;
  let prefetchAbort: AbortController | null = null;
  function cancelPrefetch(): void {
    if (prefetchTimer) clearTimeout(prefetchTimer);
    prefetchTimer = null;
    prefetchAbort?.abort();
    prefetchAbort = null;
  }
  function prefetchNeighbourOverviews(): void {
    cancelPrefetch();
    prefetchTimer = setTimeout(() => {
      prefetchTimer = null;
      if (!bounds || document.hidden) return;
      const controller = new AbortController();
      prefetchAbort = controller;
      const centre = map.getCenter();
      const half = map.getSize().divideBy(2);
      for (const dz of [-1, 1]) {
        const z = Math.round(zoom) + dz;
        if (z < map.getMinZoom() || z >= CLUSTER_FETCH_MAX_ZOOM) continue;
        const middle = map.project(centre, z);
        const sw = map.unproject(middle.add([-half.x, half.y]), z);
        const ne = map.unproject(middle.add([half.x, -half.y]), z);
        const view: Bounds = { latMin: sw.lat, latMax: ne.lat, lonMin: sw.lng, lonMax: ne.lng };
        const cached = clusterCache.find(view, (cz) => cz === z, Date.now());
        if (cached && Date.now() - cached.fetchedAt < VIEW_CACHE_FRESH_MS) continue;
        const grid = declutterCellDeg(z, planeBoxSize(z));
        const requestBounds = snapBounds(view, grid * 2);
        fetchLiveOverview(requestBounds, grid, controller.signal)
          .then((overview) => clusterCache.put({ zoom: z, bbox: requestBounds, data: overview, fetchedAt: Date.now() }))
          .catch(() => {});
      }
    }, PREFETCH_DELAY_MS);
  }

  function fetchFreshData(): void {
    fetchLiveCount()
      .then((n) => store.set("trackedCount", n))
      .catch(() => {});
    fetchLiveCount(false)
      .then((n) => store.set("seenCount", n))
      .catch(() => {});
    // A viewport request still in flight (or about to fire) already covers
    // this tick — don't stack a second one on top of it.
    if (viewportAbort || viewportFetchTimer) return;
    fetchViewport();
  }

  function handleViewportChange(nextBounds: Bounds, nextZoom: number, immediate = false): void {
    const wasZoomedOut = zoom < CLUSTER_FETCH_MAX_ZOOM;
    bounds = nextBounds;
    zoom = nextZoom;
    store.set("zoom", nextZoom);
    if ((nextZoom < CLUSTER_FETCH_MAX_ZOOM) !== wasZoomedOut) lastAppliedView = null;
    renderAircraftLayer(); // icon sizes and what overlaps change with the zoom: redraw now, independent of the fetch below
    // A view we've seen recently is drawn right away, before the debounce.
    applyCachedView(Date.now());

    // Whatever is in flight was for a viewport that no longer exists.
    cancelPrefetch();
    viewportAbort?.abort();
    viewportAbort = null;
    if (viewportFetchTimer) clearTimeout(viewportFetchTimer);
    viewportFetchTimer = null;
    if (immediate) fetchViewport();
    else viewportFetchTimer = setTimeout(fetchViewport, VIEWPORT_DEBOUNCE_MS);
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
    if (!isSelected && !inDrawnArea(p) && !overviewIndex.has(p.icao24)) return;
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
    // The overview's aircraft (zoomed out) move with the feed too, on a copy:
    // the array is shared with the view cache.
    let overviewNext: LiveMarker[] | null = null;
    for (const p of pendingWs.values()) {
      const overviewAt = overviewIndex.get(p.icao24);
      if (overviewAt !== undefined && zoom < CLUSTER_FETCH_MAX_ZOOM && isNewer(p, overviewPlanes[overviewAt])) {
        overviewNext ??= overviewPlanes.slice();
        overviewNext[overviewAt] = p;
        changed = true;
      }
      const existing = positions.get(p.icao24);
      if (existing && !isNewer(p, existing)) continue; // superseded by a /live reconcile already
      if (p.icao24 !== selectedId && !inDrawnArea(p)) continue;
      positions.set(p.icao24, p);
      changed = true;
      if (p.icao24 === selectedId) selectedUpdate = p;
    }
    pendingWs.clear();
    if (overviewNext) overviewPlanes = overviewNext; // same ids and order, so overviewIndex still holds
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
    if (overviewTimer) clearInterval(overviewTimer);
    overviewTimer = null;
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

    if (overviewTimer) clearInterval(overviewTimer);
    overviewTimer = setInterval(() => {
      if (Date.now() - cycleStart >= FETCH_STOP_MS) {
        if (overviewTimer) clearInterval(overviewTimer);
        overviewTimer = null;
        return;
      }
      if (zoom < CLUSTER_FETCH_MAX_ZOOM && !document.hidden && !viewportAbort && !viewportFetchTimer) fetchViewport();
    }, OVERVIEW_REFRESH_MS);

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
    routeTip = null;
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
      routeTip = null;
      drawRoute();
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
            drawRoute();
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
  const mapController = createMap(mapRoot, handleViewportChange, (ready) => store.set("basemapReady", ready));
  const map = mapController.map;
  // ?debug: a read-only diagnostics panel for a misbehaving device (ui/debugOverlay.ts).
  if (new URLSearchParams(location.search).has("debug")) import("./ui/debugOverlay").then((m) => m.mountDebugOverlay(map)).catch(() => {});
  const markerLayer = createMarkerLayer(map, handleSelectAircraft);
  const routeLayer = createRouteLayer(map);
  const followSelected = createFollowSelected(map, (offScreen) => store.set("planeOffScreen", offScreen));

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
  store.set("resumeTracking", startCycle);

  // ---- UI modules ----
  scaleBar.mount(map);
  import("./ui/defaultAirports").then((mod) => mod.mount(map, handleSelectAirport));

  flightSearch.mount(leftOverlayStack, store);
  favoritesPanel.mount(leftOverlayStack, store);
  legend.mount(leftOverlayStack); // no store slots — its open/closed state is purely local (see ui/legend.ts)
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

  // Tracked-chip: inline (not a separate component in the original either).
  function renderTrackedChip(): void {
    clear(trackedChipRoot);
    trackedChipRoot.appendChild(
      h(
        "div",
        { className: "tracked-chip" },
        h("span", { className: "tracked-chip-dot", "aria-hidden": "true" }),
        h(
          "div",
          { className: "tracked-chip-rows" },
          h(
            "div",
            { className: "tracked-chip-row tracked-chip-row--active" },
            h("span", { className: "tracked-chip-label" }, "Active"),
            h("span", { className: "tracked-chip-value" }, store.get("trackedCount").toLocaleString()),
          ),
          h(
            "div",
            { className: "tracked-chip-row tracked-chip-row--seen" },
            h("span", { className: "tracked-chip-label" }, "Seen"),
            h("span", { className: "tracked-chip-value tracked-chip-value--seen" }, store.get("seenCount").toLocaleString()),
          ),
        ),
      ),
    );
  }
  renderTrackedChip();
  store.subscribeMany(["trackedCount", "seenCount"], renderTrackedChip);

  // ---- follow-selected wiring ----
  function syncFollowSelected(): void {
    const selectedPos = store.get("selectedPos");
    followSelected.update({
      selectedId: store.get("selectedId"),
      positionId: selectedPos?.icao24 ?? null,
      positionFresh: store.get("selectedPosFresh"),
      lat: selectedPos?.latitude ?? null,
      lon: selectedPos?.longitude ?? null,
      onGround: selectedPos?.onGround ?? null,
      velocityMs: selectedPos?.velocityMs ?? null,
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
  fetchLiveCount(false)
    .then((n) => store.set("seenCount", n))
    .catch(() => {});

  subscribeLiveFeed(onLivePush);

  restartFetchCycleTimers(); // generation 0

  // Opening view: move the map to where the traffic is, at a zoom that draws
  // individual aircraft, before the first viewport report (see
  // map/initialView.ts). One coarse world summary, at most
  // INITIAL_VIEW_TIMEOUT_MS; anything going wrong keeps the default view.
  // The boot screen is still up meanwhile (it waits on the first load).
  function applyInitialView(): Promise<void> {
    if (getMockPlaneCount() != null) return Promise.resolve(); // the ?mockPlanes dev tool frames its own view
    const startCenter = map.getCenter();
    const startZoom = map.getZoom();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), INITIAL_VIEW_TIMEOUT_MS);
    // The visitor's approximate location (when the server has one) replaces
    // the fixed default centre; fetched alongside the summary, under the same
    // timeout, so it never holds the boot screen longer than the summary does.
    const summaryRequest = fetchLiveClusters({ latMin: -90, latMax: 90, lonMin: -180, lonMax: 180 }, INITIAL_SUMMARY_GRID_DEG, controller.signal).catch(() => null);
    return Promise.all([summaryRequest, fetchGeo(controller.signal)])
      .then(([summary, geo]) => {
        // Someone (the user, a test) already moved the map: leave it alone.
        // (Not strict equality: re-measuring the container can nudge the centre by a fraction of a pixel.)
        const c = map.getCenter();
        if (map.getZoom() !== startZoom || Math.abs(c.lat - startCenter.lat) > 0.01 || Math.abs(c.lng - startCenter.lng) > 0.01) return;
        const center = geo ?? DEFAULT_VIEW;
        const view = summary ? pickInitialView(summary, center, { width: mapRoot.clientWidth, height: mapRoot.clientHeight }) : null;
        if (view) map.setView([view.lat, view.lon], view.zoom, { animate: false });
        // No traffic data to choose a zoom from: still open where the visitor is.
        else if (geo) map.setView([geo.lat, geo.lon], DEFAULT_VIEW.zoom, { animate: false });
      })
      .catch(() => {})
      .finally(() => clearTimeout(timer));
  }

  // Initial viewport report — equivalent to the original ViewportReporter's
  // own mount-time call, fired only now that every layer it can cascade
  // into (markers, clusters, route) exists.
  applyInitialView().then(() => handleViewportChange(boundsFromMap(map), map.getZoom(), true));
}

boot();
