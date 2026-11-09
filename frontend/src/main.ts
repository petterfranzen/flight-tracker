import { Store } from "./state/store";
import type { AppState } from "./state/appState";
import { h, clear } from "./ui/h";
import type { FavoriteAircraft, FavoriteRoute } from "./favorites";
import { loadFavoriteAircraft, loadFavoriteRoutes, toggleFavoriteAircraft, toggleFavoriteRoute } from "./favorites";
import { loadWatched, saveWatched, watchKey, type WatchedFlight } from "./watchlist";
import type { AirportSelection, Bounds, FlightPosition, LiveMarker, LiveOverview, SelectedPosition, TrackStatus } from "./types/flight";
import {
  fetchAircraftDossier,
  fetchAirportInfo,
  fetchFlightLive,
  fetchFlightStatus,
  fetchHistory,
  fetchLiveClusters,
  fetchLiveOverview,
  fetchGeo,
  fetchLiveCount,
  fetchLivePositions,
  fetchPollingStatus,
  restartPolling,
  searchSchedule,
  searchScheduleWithStatus,
  subscribeLiveFeed,
  type ScheduledFlight,
} from "./api/flightApi";
import { NOTIFY_ENABLED, notificationPermission, showOsNotification } from "./notify/notifier";
import { loadNotifyState, saveNotifyState, pruneNotifyState, emptyState, forgetFlight } from "./notify/state";
import { chooseChannel, observeFlight } from "./notify/detect";
import { boundsFromMap, createFollowSelected, createMap, DEFAULT_VIEW, GPUInitializationError } from "./map/map";
import { createPlaneLayer, planeBoxSize } from "./map/planes";
import { declutterCellDeg, newDeclutterMemory, pickNonOverlapping, spacingKey, spacingLevel, type Candidate } from "./map/declutter";
import { isSmallScreen } from "./map/screen";
import { pickInitialView } from "./map/initialView";
import { getMockPlaneCount } from "./api/mockFleet";
import { agedIds, findShadowedIds, isActiveTraffic, OVERLAP_MIN_ZOOM } from "./map/staleness";
import { hiddenLandedIds } from "./map/landed";
import { newerReport, notOlderReport, sameReport } from "./map/reportOrder";
import { createRouteLayer } from "./map/route";
import { confirmedGate, displayedPosition, gateDisplay, trailFor, type GateDisplay } from "./map/gatePlacement";
import { createUncertaintyLayer } from "./map/uncertainty";
import { keepCellWinners } from "./map/cellWinners";
import { snapBounds, ViewCache, type CachedView } from "./map/viewCache";
import { holdOverviewFrame, newOverviewHold } from "./map/overviewHold";
import * as scaleBar from "./ui/scaleBar";
import * as dock from "./ui/dock";
import * as flightSearch from "./ui/flightSearch";
import * as favoritesPanel from "./ui/favoritesPanel";
import * as watchPanel from "./ui/watchPanel";
import * as watchToast from "./ui/watchToast";
import * as legend from "./ui/legend";
import * as installPrompt from "./ui/installPrompt";
import * as dossierPanel from "./ui/dossierPanel";
import * as bootScreen from "./ui/bootScreen";
import * as resumeDialog from "./ui/resumeDialog";
import * as webglNotice from "./ui/webglNotice";
// Self-hosted cyberpunk face (latin subset).
import "@fontsource/jetbrains-mono/latin-500.css";
import "@fontsource/jetbrains-mono/latin-600.css";
import "@fontsource/jetbrains-mono/latin-700.css";
import "./components/FlightMap.css"; // app-shell/header/dock/details-panel/tracked-chip/resume-dialog styles — kept unchanged

// See the comment block above FETCH_INTERVAL_MS in the original FlightMap.tsx
// for the full "watch lifecycle" picture this drives.
const FETCH_INTERVAL_MS = 72_000;
// While coverage is lost the estimate's radius grows, so the status is refetched this often.
const COVERAGE_LOST_REFETCH_MS = 15_000;
// While the landing is only inferred a provider may confirm it, and while it is confirmed without a gate
// (LANDED_CONFIRMED) the gate may follow, at any time.
const LANDED_REFETCH_MS = 60_000;
const FETCH_STOP_MS = 5 * 60_000;
// Gates are in the basemap's zoom-14 tiles, which load from this app zoom (map.findGate).
// From here a view that shows the plane has those tiles loaded or loading, so a gate that
// is still missing is not in the map and moving the camera would not find it.
const GATE_TILE_ZOOM = 15;
// Where the one-time fly-to to a confirmed gate goes.
const GATE_LOOKUP_ZOOM = 16;
const DIALOG_STOP_MS = 5 * 60_000;

// Below this zoom the map asks the server for a thinned-out set (one plane per
// half-icon cell, first discovered first — see fetchLiveOverview) instead of
// every aircraft in view. There are no clusters: planes whose icons would
// overlap are hidden, the first discovered one stays (map/declutter.ts).
const CLUSTER_FETCH_MAX_ZOOM = 8;

// The map zooms fractionally; overview requests and their cache entries are
// per whole level, the nearest one that still uses the overview.
function overviewZoom(zoom: number): number {
  return Math.min(Math.round(zoom), CLUSTER_FETCH_MAX_ZOOM - 1);
}

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

// The most planes drawn at once. Planes are drawn by the map (map/planes.ts),
// but every render projects the candidates and re-sends the drawn set to the
// map's worker, and a dense view past a few hundred icons reads as noise
// anyway; a phone has a fraction of a laptop's CPU. Above it, planes are
// spaced further apart rather than cut off.
const MAX_DRAWN_MARKERS = 300;
const MAX_DRAWN_MARKERS_SMALL_SCREEN = 150;

// How long the view must sit still before the zoom levels either side of it are
// fetched in the background, so the next zoom step is drawn from cache.
const PREFETCH_DELAY_MS = 600;

// A view that has just changed is still being learnt: /live carries part of it
// and the rest follows as WebSocket frames, report by report, over several
// seconds. Aircraft those frames bring that the snapshot did not have are held
// for this long after the view changes and drawn together in one update, not
// one by one (#151): until none has arrived for FILL_QUIET_MS, or FILL_MAX_MS
// after the first. Later arrivals, in a view that has settled, are drawn as
// they land.
const FILL_SETTLE_MS = 8_000;
const FILL_MIN_SNAPSHOT = 5;
const FILL_QUIET_MS = 4_000;
const FILL_MAX_MS = 12_000;

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

/**
 * A drawn position carries the time its information was produced, `asOf`: a
 * viewport snapshot's fetch time, a WebSocket push's arrival, or — for the
 * selected plane — its estimate's own time.
 *
 * `observedAt` alone cannot order positions. The server serves each plane's
 * dead-reckoned position, so two snapshots of the same last report share
 * `observedAt` with *different* positions, the older snapshot's several
 * seconds behind. Comparing `observedAt` strictly therefore let a cached view
 * drawn during a pan/zoom overwrite the fresher position already on screen:
 * the marker popped backwards along its track and forward again when the
 * response landed (#53 / #97). `asOf` orders them, so a position older than
 * the one drawn never replaces it.
 */
interface AsOfMarker extends LiveMarker {
  asOf: number;
}

/** The overview payload as its view cache holds it: every plane stamped. */
interface AsOfOverview extends Omit<LiveOverview, "planes"> {
  planes: AsOfMarker[];
}

/** A snapshot's markers, stamped with the time it was fetched. */
function stamp(list: LiveMarker[], asOf: number): AsOfMarker[] {
  return list.map((p) => ({ ...p, asOf }));
}

/**
 * Whether `incoming` sits further along the aircraft's own track than `existing`
 * (the sign of the displacement along `existing`'s heading).
 */
function aheadOf(existing: LiveMarker, incoming: LiveMarker): boolean {
  const heading = ((existing.headingDeg ?? incoming.headingDeg ?? 0) * Math.PI) / 180;
  const dx = incoming.longitude - existing.longitude;
  const dy = incoming.latitude - existing.latitude;
  return dx * Math.sin(heading) + dy * Math.cos(heading) > 0;
}

/**
 * The position to draw, given what is already drawn and what a payload says.
 *
 * `asOf` (the time the information was produced) orders payloads of the same
 * report taken at different times, and on a tie the drawn one is kept. But two
 * payloads of the *same report* (`observedAt` naming the same instant, however
 * it is spelled) sit at different points along the track: a snapshot is the
 * report dead-reckoned forward, a raw report is the report itself. For the same
 * report the further-along position is the later information, so it wins and
 * the marker never moves backwards (#150).
 */
function newerOf(existing: AsOfMarker | undefined, incoming: AsOfMarker): AsOfMarker {
  if (!existing) return incoming;
  if (sameReport(existing.observedAt, incoming.observedAt)) return aheadOf(existing, incoming) ? incoming : existing;
  return existing.asOf >= incoming.asOf ? existing : incoming;
}

/**
 * Whether a WebSocket frame should move a marker that is already drawn.
 *
 * A LiveFrame carries the aircraft's **raw** last report (LiveFrame.of in the
 * backend, straight off the persisted position), while `/live` and
 * `/live/overview` serve the server's **dead-reckoned** display position: the
 * same report projected forward along its own track by
 * EstimatedPositionService (up to `speed x report age`, and the estimate is
 * refreshed on its own cycle). The two payloads of the *same* report therefore
 * share `observedAt` with positions several km apart.
 *
 * So a frame only moves a marker when it carries a report **strictly newer**
 * than the one already drawn. For the same report the drawn position - a
 * snapshot's dead-reckoned estimate - stands: it is the more current answer to
 * "where is the aircraft now". Applying the frame instead pulled the marker
 * back to the raw report, and the next refresh snapped it forward again: the
 * idle reversion of #150, where frame and refresh disagreed about the same
 * report and each redraw took the other's side.
 *
 * Both comparisons go through `Date.parse` (map/reportOrder.ts): `observedAt`
 * can arrive spelled with an offset, or with or without fractional seconds, and
 * ordering the strings would put two reports in the wrong order.
 *
 * A genuinely new report has a newer `observedAt`, so it still moves the marker
 * immediately.
 */
function frameAdvances(existing: LiveMarker | undefined, p: FlightPosition): boolean {
  return existing === undefined || newerReport(p.observedAt, existing.observedAt);
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
  const watchToastRoot = h("div");
  const mapRoot = h("div");
  const dossierRoot = h("div");
  appShell.append(bootScreenRoot, dockRoot, leftOverlayStack, trackedChipRoot, resumeDialogRoot, watchToastRoot, mapRoot, dossierRoot);
  rootEl.appendChild(appShell);

  // PWA install control (#85): shown only when the browser offers an
  // install prompt (Chrome/Edge/Android), or as a one-line Share > Add to
  // Home Screen hint on iOS. It hides itself when already standalone and
  // remembers a dismissal. See ui/installPrompt.ts.
  installPrompt.mount(appShell);

  // Minimal worker (#85 reuses #82's decision; one worker, not two). It
  // caches nothing — its header says why — so a deploy can never be kept
  // off a phone by a stale shell. Registering it is what lets Chrome show
  // "Install app" and gives #82 registration.showNotification() on Android
  // and installed iOS.
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // Private mode / storage disabled: the app works without it.
    });
  }

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
    trackStatus: null,
    dossierExpanded: false,
    planeOffScreen: false,
    focusRequest: 0,
    nowMs: Date.now(),

    airportDossier: null,
    airportInfo: null,

    favoriteRoutes: loadFavoriteRoutes(),
    favoriteAircraft: loadFavoriteAircraft(),

    watchedFlights: loadWatched(),
    watchedStatus: {},
    departureToast: null,
    watchNotice: null,

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

    watchFlight: () => {},
    unwatchFlight: () => {},
    goToWatched: () => {},
    dismissDepartureToast: () => {},
    dismissWatchNotice: () => {},
  };
  const store = new Store<AppState>(state);

  // ---- local mutable state (the original's useRef/useState-outside-store) ----
  // Only ever holds the aircraft in the current individual-marker viewport
  // (zoom >= CLUSTER_FETCH_MAX_ZOOM) plus the selected one — never "every
  // aircraft we've heard about". Mutated in place: copying it per update
  // was O(n) per WebSocket frame.
  const positions = new Map<string, AsOfMarker>();
  // Zoomed out: the thinned-out set of active aircraft the server sent (see fetchLiveOverview).
  let overviewPlanes: AsOfMarker[] = [];
  const overviewIndex = new Map<string, number>(); // icao24 -> index in overviewPlanes
  function setOverviewPlanes(list: AsOfMarker[]): void {
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
  const clusterCache = new ViewCache<AsOfOverview>(VIEW_CACHE_MAX_ENTRIES, VIEW_CACHE_MAX_AGE_MS);
  const liveCache = new ViewCache<AsOfMarker[]>(VIEW_CACHE_MAX_ENTRIES, VIEW_CACHE_MAX_AGE_MS);
  let lastAppliedView: CachedView<unknown> | null = null;
  // The overview's frame is held across refreshes and across the zoom-8
  // threshold, so a plane that lands or drops out of the cell thinning stays
  // on screen (see map/overviewHold.ts).
  const overviewHold = newOverviewHold<AsOfMarker>();
  // Frames of aircraft the drawn set does not have yet, held while a changed
  // view fills in (FILL_SETTLE_MS) and released together (see flushLivePushes).
  const arrivals = new Map<string, { p: FlightPosition; asOf: number }>();
  let fillUntil = 0;
  let viewChanged = false; // a view change whose snapshot has not landed yet
  let liveSnapshotSeen = false; // the opening view is never held
  let arrivalTimer: ReturnType<typeof setTimeout> | null = null;
  // Which source the map is drawing from right now. A cached view from the
  // other side is not this frame: drawing it would swap the whole set before
  // the response for the new zoom arrives.
  let drawnSource: "overview" | "live" | null = null;

  function sourceAt(): "overview" | "live" {
    return zoom < CLUSTER_FETCH_MAX_ZOOM ? "overview" : "live";
  }

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
  // The trail is the real reports (routePoints) and ends at the marker
  // (selectedPos), so the two can never disagree. The server dead-reckons a
  // position forward from the last real report and sends it with that
  // report's own observedAt, so a point with an unchanged observedAt is an
  // estimate, not a new fix: it only moves the end of the trail. Baking each
  // one into the trail (as this used to) made it run past the real track
  // whenever only polls were arriving (zoomed out, no live pushes), then
  // zigzag back when the next real report landed. Likewise reports newer
  // than the marker's position (a history fetched after the plane was
  // selected from an older list) wait until the marker gets there: drawn
  // straight away, they ran the trail ahead of the plane.
  function drawRoute(): void {
    const pos = store.get("selectedPos");
    const tip = pos && pos.icao24 === store.get("selectedId") ? pos : null;
    route = trailFor(routePoints, tip, currentGateDisplay(), Date.now());
    routeLayer.update(route);
  }

  // ---- confirmed gate ----
  // A plane whose gate a provider confirmed is drawn at the gate once its last
  // report is old (map/gatePlacement.ts). The gate's coordinate is the gate's
  // own point in the basemap's vector tiles (aeroway class "gate", by ref),
  // which are loaded only while the view is at the airport: it is looked up
  // when the status arrives and again whenever tiles load, until found.
  let gatePoint: { icao24: string; gate: string; lat: number; lon: number } | null = null;
  function currentGateDisplay(): GateDisplay | null {
    const pos = store.get("selectedPos");
    const status = store.get("trackStatus");
    const gate = confirmedGate(pos, status);
    const point = gate && gatePoint && gatePoint.icao24 === pos?.icao24 && gatePoint.gate === gate ? gatePoint : null;
    return gateDisplay(pos, status, Date.now(), point);
  }
  // Once per selection, if the gate's tile is not loaded: go where it is. Never against
  // the user: not after they moved the map since selecting, nor while it is moving.
  let gateZoomDone = false;
  let userMovedMap = false; // set by the map's user-move listener (below, once `map` exists)
  function onGateStatus(status: TrackStatus | null): void {
    resolveGate();
    const pos = store.get("selectedPos");
    const gate = confirmedGate(pos, status);
    if (gate && status && !gateZoomDone && !(gatePoint && gatePoint.gate === gate && gatePoint.icao24 === pos?.icao24)) {
      gateZoomDone = true;
      flyToGate(store.get("selectedId"), status.lastSeenLat, status.lastSeenLon);
    }
    renderAircraftLayer(); // the status can also stop qualifying (a gate that changed)
    drawRoute();
  }
  // The selection's own camera move is usually still running when the status arrives: wait
  // for it to end, then decide. Whatever the user did meanwhile (or the gate resolving) wins.
  function flyToGate(selectedId: string | null, lat: number, lon: number): void {
    if (map.isMoving()) {
      const retry = () => {
        map.off("moveend", retry);
        flyToGate(selectedId, lat, lon);
      };
      map.on("moveend", retry);
      return;
    }
    if (store.get("selectedId") !== selectedId || userMovedMap || gatePoint) return;
    // The gate tiles are already in reach (zoom, and the plane in view): the gate is not in
    // the basemap, and no camera move can change that.
    if (map.getZoom() >= GATE_TILE_ZOOM && map.contains(lat, lon)) return;
    map.flyTo([lat, lon], GATE_LOOKUP_ZOOM, 800);
  }
  function resolveGate(): void {
    const pos = store.get("selectedPos");
    const status = store.get("trackStatus");
    const gate = confirmedGate(pos, status);
    if (!pos || !status || !gate) return;
    if (gatePoint && gatePoint.icao24 === pos.icao24 && gatePoint.gate === gate) return;
    const found = map.findGate(gate, { lat: status.lastSeenLat, lon: status.lastSeenLon });
    if (!found) return;
    gatePoint = { icao24: pos.icao24, gate, lat: found.lat, lon: found.lon };
    renderAircraftLayer();
    drawRoute();
  }
  function appendRoutePoint(p: LiveMarker): void {
    if (lastRouteObservedAt == null || newerReport(p.observedAt, lastRouteObservedAt)) {
      // A new real report: it joins the trail.
      lastRouteObservedAt = p.observedAt;
      const last = routePoints[routePoints.length - 1];
      if (!(last && last.lat === p.latitude && last.lon === p.longitude)) {
        routePoints = [...routePoints, { lat: p.latitude, lon: p.longitude, observedAt: p.observedAt }];
      }
    }
    drawRoute();
  }

  // ---- aircraft rendering ----
  // Which planes were drawn last time, so a pan keeps them (see pickNonOverlapping).
  const declutterMemory = newDeclutterMemory();
  function renderAircraftLayer(): void {
    const selectedId = store.get("selectedId");
    const reportedPos = store.get("selectedPos");
    // At its confirmed gate, not at its last (old) report: a display state only.
    const selectedPos = reportedPos ? displayedPosition(reportedPos, currentGateDisplay()) : null;
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
    // Watched flights' own live positions (see pollWatched): a watched plane may
    // sit outside the current viewport's data, and it is drawn either way.
    const watchedIds = watchedIcao24s();
    const knownIds = new Set(source.map((p) => p.icao24));
    const watchedExtra = Array.from(watchedLive.values()).filter((p) => p.icao24 !== selectedId && !knownIds.has(p.icao24));
    const all = watchedExtra.length > 0 ? source.concat(watchedExtra) : source;
    const inView = all.filter((p) => p.icao24 !== selectedId && (!view || inBounds(view, p.latitude, p.longitude)));
    // An aircraft with a newer one on top of it is a ghost: not drawn at all
    // (see map/staleness.ts). Only where 20 m is visible. A watched plane is
    // never a ghost.
    // A plane that landed (or went quiet on the ground) and has not reported
    // since is dropped: it is drawn at its last report, which for one that
    // left coverage on the ground is the runway end, hours ago (see
    // map/landed.ts). A plane a provider put at a gate is kept (its gate is
    // known, and the gate display draws it there once selected), and a watched
    // plane is kept regardless.
    const hidden = hiddenLandedIds(inView, nowMs);
    const shown = hidden.size > 0 ? inView.filter((p) => !hidden.has(p.icao24) || watchedIds.has(p.icao24)) : inView;
    const shadowed = zoom >= OVERLAP_MIN_ZOOM ? findShadowedIds(shown) : null;
    const candidates = shadowed && shadowed.size > 0 ? shown.filter((p) => !shadowed.has(p.icao24) || watchedIds.has(p.icao24)) : shown;

    // Where two planes' icons would overlap, only the first discovered is
    // drawn; the selected one is always drawn and hides whatever is under it.
    const points: Candidate[] = candidates.map((p) => {
      const pt = map.project(p.latitude, p.longitude);
      return { icao24: p.icao24, x: pt.x, y: pt.y, active: isActiveTraffic(p, nowMs) };
    });
    const fixed = selectedPos ? [map.project(selectedPos.latitude, selectedPos.longitude)] : [];
    // Watched planes are placed like the selected one: nothing is drawn over
    // them, and they are kept whatever the spacing does.
    for (const p of candidates) if (watchedIds.has(p.icao24)) fixed.push(map.project(p.latitude, p.longitude));
    // The spacing belongs to the zoom level and the cap: a pan that keeps both
    // keeps it too, so the planes already drawn stay where they are and only
    // the newcomers are spaced further apart when the cap is passed. The box it
    // is measured in and the key it is stored under come from the same whole
    // level (spacingLevel), so a pinch inside one level leaves neither stale
    // against the other, and the source is part of the key so the 7.5-8.0
    // overview band does not hand its spacing to the live source above it.
    const maxDrawn = isSmallScreen() ? MAX_DRAWN_MARKERS_SMALL_SCREEN : MAX_DRAWN_MARKERS;
    const keep = pickNonOverlapping(
      points,
      fixed,
      planeBoxSize(spacingLevel(zoom)),
      maxDrawn,
      declutterMemory,
      spacingKey(useOverview ? "overview" : "live", zoom, maxDrawn),
    );
    // A watched plane is always drawn: exempt from the marker cap and declutter.
    const drawn = candidates.filter((p) => keep.has(p.icao24) || watchedIds.has(p.icao24));

    planeLayer.update({
      unselected: drawn,
      selectedPos,
      // Reports older than 2 h are drawn dimmed (see map/staleness.ts).
      dimmed: agedIds(drawn, nowMs),
      watched: watchedIds,
    });
  }

  // ---- fetch lifecycle ----
  function applyLiveSnapshot(list: AsOfMarker[]): void {
    // The snapshot is the whole truth for this view: frames held for it are
    // superseded. It opens the fill window only for a view change that lands a
    // real set; the opening view, and an empty or sparse snapshot, never hold
    // anything back.
    arrivals.clear();
    if (arrivalTimer) clearTimeout(arrivalTimer);
    arrivalTimer = null;
    fillUntil = liveSnapshotSeen && viewChanged && list.length >= FILL_MIN_SNAPSHOT ? Date.now() + FILL_SETTLE_MS : 0;
    liveSnapshotSeen = true;
    viewChanged = false;
    if (overviewPlanes.length > 0) setOverviewPlanes([]); // the snapshot is the source from here on
    drawnSource = "live";
    const selectedId = store.get("selectedId");
    const selectedKept = selectedId ? positions.get(selectedId) : undefined;
    const previous = new Map(positions);
    positions.clear();
    for (const p of list) {
      const existing = previous.get(p.icao24);
      positions.set(p.icao24, newerOf(existing, p));
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

  function findCachedView(now: number): CachedView<AsOfOverview> | CachedView<AsOfMarker[]> | null {
    if (!bounds) return null;
    return zoom < CLUSTER_FETCH_MAX_ZOOM
      ? clusterCache.find(bounds, (z) => z === overviewZoom(zoom), now)
      : liveCache.find(bounds, (z) => z >= CLUSTER_FETCH_MAX_ZOOM, now);
  }

  // The overview replaces the zoomed-in snapshot: its aircraft are what is
  // drawn now, so the snapshot's are dropped (the selected one is kept). What
  // the response does not return but the map was drawing is held instead of
  // vanishing (see map/overviewHold.ts), which is also what keeps the frame
  // whole when the map crosses back down from CLUSTER_FETCH_MAX_ZOOM.
  function applyOverview(planes: AsOfMarker[]): void {
    const selectedId = store.get("selectedId");
    const drawn = overviewPlanes.concat(Array.from(positions.values()).filter((p) => p.icao24 !== selectedId));
    const view = bounds ? padBounds(bounds, RENDER_MARGIN) : null;
    setOverviewPlanes(holdOverviewFrame(overviewHold, planes, drawn, (p) => !view || inBounds(view, p.latitude, p.longitude), Date.now()));
    for (const id of Array.from(positions.keys())) if (id !== selectedId) positions.delete(id);
    drawnSource = "overview";
    renderAircraftLayer();
  }

  /** Draws the best cached data for the current view, if any and not already on screen. */
  function applyCachedView(now: number): CachedView<AsOfOverview> | CachedView<AsOfMarker[]> | null {
    const hit = findCachedView(now);
    if (!hit || hit === lastAppliedView) return hit;
    // A cached view of the *other* source, right after the map crossed the
    // threshold: it is a full frame of stale planes in place of the one on
    // screen, which the response then has to replace again. Hold what is
    // drawn until that response lands (fetchViewport below asks for it).
    if (drawnSource && drawnSource !== sourceAt()) return null;
    lastAppliedView = hit;
    if (zoom < CLUSTER_FETCH_MAX_ZOOM) {
      applyOverview((hit.data as AsOfOverview).planes);
    } else {
      applyLiveSnapshot(hit.data as AsOfMarker[]);
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
    const requestZoom = zoom < CLUSTER_FETCH_MAX_ZOOM ? overviewZoom(zoom) : Math.round(zoom);
    const done = (): void => {
      if (viewportAbort === controller) viewportAbort = null;
      store.set("firstLoadDone", true);
    };
    if (zoom < CLUSTER_FETCH_MAX_ZOOM) {
      const grid = declutterCellDeg(requestZoom, planeBoxSize(requestZoom));
      const requestBounds = snapBounds(bounds, grid * 2);
      // The frame drawn for this zoom and bbox last time (see ViewCache): its
      // cells keep their winners until they are no longer live and in-cell.
      const previous = clusterCache.find(requestBounds, (z) => z === requestZoom, now)?.data.planes ?? [];
      fetchLiveOverview(requestBounds, grid, controller.signal)
        .then((overview) => {
          const fetchedAt = Date.now();
          // Only the response's planes are stamped with this fetch time: a cell
          // winner kept from `previous` stays where it was drawn, with the older
          // as-of it was drawn at.
          const planes: AsOfMarker[] = keepCellWinners(previous, stamp(overview.planes, fetchedAt), grid, fetchedAt);
          const entry = { zoom: requestZoom, bbox: requestBounds, data: { ...overview, planes }, fetchedAt };
          clusterCache.put(entry);
          if (controller.signal.aborted || zoom >= CLUSTER_FETCH_MAX_ZOOM || overviewZoom(zoom) !== requestZoom) return;
          lastAppliedView = entry;
          applyOverview(planes);
          prefetchNeighbourOverviews();
        })
        .catch(() => {})
        .finally(done);
      return;
    }
    const requestBounds = bounds;
    fetchLivePositions(requestBounds, controller.signal)
      .then((list) => {
        const fetchedAt = Date.now();
        const entry = { zoom: requestZoom, bbox: requestBounds, data: stamp(list, fetchedAt), fetchedAt };
        liveCache.put(entry);
        if (controller.signal.aborted || zoom < CLUSTER_FETCH_MAX_ZOOM) return;
        lastAppliedView = entry;
        applyLiveSnapshot(entry.data);
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
      for (const dz of [-1, 1]) {
        const z = Math.round(zoom) + dz;
        if (z < map.getMinZoom() || z >= CLUSTER_FETCH_MAX_ZOOM) continue;
        const view = map.boundsAt(z);
        const cached = clusterCache.find(view, (cz) => cz === z, Date.now());
        if (cached && Date.now() - cached.fetchedAt < VIEW_CACHE_FRESH_MS) continue;
        const grid = declutterCellDeg(z, planeBoxSize(z));
        const requestBounds = snapBounds(view, grid * 2);
        const previous = clusterCache.find(requestBounds, (cz) => cz === z, Date.now())?.data.planes ?? [];
        fetchLiveOverview(requestBounds, grid, controller.signal)
          .then((overview) => {
            const fetchedAt = Date.now();
            const planes: AsOfMarker[] = keepCellWinners(previous, stamp(overview.planes, fetchedAt), grid, fetchedAt);
            clusterCache.put({ zoom: z, bbox: requestBounds, data: { ...overview, planes }, fetchedAt });
          })
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
    viewChanged = true;
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
    // Latest arrival wins: a LiveFrame is pushed the moment its report is
    // persisted, so the newest one is the truth, and two frames of the same
    // dead-reckoned report share observedAt (#53 / #97).
    pendingWs.set(p.icao24, p);
    if (!wsFlushTimer) wsFlushTimer = setTimeout(flushLivePushes, WS_FLUSH_MS);
  }

  // Frames of aircraft the drawn set does not have yet, held while a changed
  // view fills in (FILL_SETTLE_MS) and released together.
  let firstArrivalAt = 0;
  function holdArrival(p: FlightPosition, at: number): void {
    if (arrivals.size === 0) firstArrivalAt = at;
    arrivals.set(p.icao24, { p, asOf: at });
    if (arrivalTimer) clearTimeout(arrivalTimer);
    arrivalTimer = setTimeout(releaseArrivals, Math.max(0, Math.min(at + FILL_QUIET_MS, firstArrivalAt + FILL_MAX_MS) - at));
  }
  function releaseArrivals(): void {
    arrivalTimer = null;
    if (arrivals.size === 0) return;
    let added = false;
    for (const { p, asOf } of arrivals.values()) {
      if (positions.has(p.icao24) || !inDrawnArea(p)) continue; // a snapshot has them, or the view moved on
      positions.set(p.icao24, { ...p, asOf });
      added = true;
    }
    arrivals.clear();
    if (added) renderAircraftLayer();
  }

  function flushLivePushes(): void {
    wsFlushTimer = null;
    if (pendingWs.size === 0) return;
    const arrival = Date.now();
    const selectedId = store.get("selectedId");
    let selectedUpdate: FlightPosition | null = null;
    let changed = false;
    // The overview's aircraft (zoomed out) move with the feed too, on a copy:
    // the array is shared with the view cache.
    let overviewNext: AsOfMarker[] | null = null;
    for (const p of pendingWs.values()) {
      const overviewAt = overviewIndex.get(p.icao24);
      const drawnOverview = overviewAt !== undefined ? overviewPlanes[overviewAt] : undefined;
      if (drawnOverview !== undefined && zoom < CLUSTER_FETCH_MAX_ZOOM && frameAdvances(drawnOverview, p) && arrival > drawnOverview.asOf) {
        overviewNext ??= overviewPlanes.slice();
        overviewNext[overviewAt as number] = { ...p, asOf: arrival };
        changed = true;
      }
      const existing = positions.get(p.icao24);
      // Superseded by a /live reconcile already, or by a snapshot that already
      // carries a position from this same report: the frame is the raw report,
      // the snapshot its dead-reckoned display (see frameAdvances).
      if (existing && (existing.asOf >= arrival || !frameAdvances(existing, p))) continue;
      if (p.icao24 !== selectedId && !inDrawnArea(p)) continue;
      if (!existing && p.icao24 !== selectedId && (arrival < fillUntil || arrivals.size > 0)) {
        // New to the drawn set while the view is still filling in: held, so the
        // fill is one update.
        holdArrival(p, arrival);
        continue;
      }
      positions.set(p.icao24, { ...p, asOf: arrival });
      changed = true;
      if (p.icao24 === selectedId) selectedUpdate = p;
    }
    pendingWs.clear();
    if (overviewNext) overviewPlanes = overviewNext; // same ids and order, so overviewIndex still holds
    if (changed) renderAircraftLayer();
    if (selectedUpdate) {
      // A LiveFrame carries marker fields only: keep the altitude, speed and
      // vertical rate the selected plane's own poll filled in.
      const prev = store.get("selectedPos");
      const update = Object.fromEntries(Object.entries(selectedUpdate).filter(([, v]) => v !== undefined));
      store.set("selectedPos", prev && prev.icao24 === selectedUpdate.icao24 ? { ...prev, ...update } : selectedUpdate);
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
  // ---- coverage-gap status of the selected plane ----
  // Fetched with every priority poll; while coverage is lost it is also
  // refetched on its own timer, so the uncertainty cone keeps growing, and
  // while the landing is inferred more slowly, so a confirmation shows up
  // without reselecting.
  let statusTimer: ReturnType<typeof setInterval> | null = null;
  let statusTimerMs = 0;
  let statusSeq = 0;
  function stopStatusPoll(): void {
    if (statusTimer) clearInterval(statusTimer);
    statusTimer = null;
    statusSeq++; // anything still in flight is for a previous selection
    store.set("trackStatus", null);
    uncertaintyLayer.update(null);
  }
  /**
   * The cone refreshes every 15 s while coverage is lost, but the /live poll
   * (which also dead-reckons) only runs every 72 s, so without this the
   * marker would trail the cone's centre by minutes of flight. The marker
   * takes the estimate's position and keeps its heading; its observedAt is
   * unchanged, so the trail treats it as a movable tip, not a new fix.
   */
  function moveSelectedToEstimate(icao24: string, status: TrackStatus): void {
    const est = status.estimate;
    const prev = store.get("selectedPos");
    if (!est || !prev || prev.icao24 !== icao24) return;
    // A real report newer than this status is already on screen: the status is the stale one.
    if (Date.parse(prev.observedAt) > Date.parse(status.lastSeenAt)) return;
    if (prev.latitude === est.lat && prev.longitude === est.lon) return;
    const moved = { ...prev, latitude: est.lat, longitude: est.lon, asOf: Date.now() };
    const known = positions.get(icao24);
    // The estimate is the freshest position there is (dead-reckoned to now), so
    // its as-of is now: a snapshot of the same report that lands later must not
    // pull the marker back to the raw position.
    if (known && moved.asOf >= known.asOf) positions.set(icao24, { ...known, latitude: est.lat, longitude: est.lon, asOf: moved.asOf });
    store.set("selectedPos", moved);
    if (lastRouteObservedAt != null) appendRoutePoint(moved);
    renderAircraftLayer();
  }
  function refreshStatus(icao24: string): void {
    const seq = ++statusSeq;
    fetchFlightStatus(icao24).then((status) => {
      if (seq !== statusSeq || icao24 !== store.get("selectedId")) return; // superseded, or another plane is selected now
      store.set("trackStatus", status);
      uncertaintyLayer.update(status);
      if (status?.estimate) moveSelectedToEstimate(icao24, status);
      onGateStatus(status);
      const landed = status?.state === "LANDED_INFERRED" || status?.state === "LANDED_CONFIRMED";
      const wantedMs = status?.state === "COVERAGE_LOST" ? COVERAGE_LOST_REFETCH_MS : landed ? LANDED_REFETCH_MS : 0;
      if (statusTimer && statusTimerMs !== wantedMs) {
        clearInterval(statusTimer);
        statusTimer = null;
      }
      if (wantedMs && !statusTimer) {
        statusTimerMs = wantedMs;
        statusTimer = setInterval(() => refreshStatus(icao24), wantedMs);
      }
    });
  }

  function startPriorityPoll(icao24: string): void {
    let inFlight = false;
    function poll(): void {
      if (inFlight) return; // never overlap with a slow previous poll
      inFlight = true;
      refreshStatus(icao24);
      fetchFlightLive(icao24)
        .then((p) => {
          if (!p || p.icao24 !== store.get("selectedId")) return;
          const existing = positions.get(p.icao24);
          // A newer live push may have beaten this response; either way the
          // selection now has a server position from after it was made.
          const best = newerOf(existing, { ...p, asOf: Date.now() });
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
    stopStatusPoll();
    stopNowMsTicker();

    // Cleared unconditionally: switching directly from aircraft A to B
    // never passes through "selected = null".
    gatePoint = null;
    gateZoomDone = false;
    userMovedMap = false;
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
      const filtered = legStartAt ? track.filter((p) => notOlderReport(p.observedAt, legStartAt!)) : track;
      if (filtered.length > 0) lastRouteObservedAt = filtered[filtered.length - 1].observedAt;
      routePoints = filtered.map((p) => ({ lat: p.latitude, lon: p.longitude, observedAt: p.observedAt }));
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
          const trimmed = routePoints.filter((pt) => notOlderReport(pt.observedAt, legStartAt!));
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
    const p: LiveMarker = known ?? selected;
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

  // ---- watched flights: the background follow ----
  // The latest live position of each watched flight that is airborne, kept
  // apart from `positions` (a viewport snapshot) so the map highlight survives
  // a refetch and can sit outside the viewport's own data.
  const watchedLive = new Map<string, AsOfMarker>();
  // The airborne state seen last poll, per watchKey, so a departure is a
  // transition (false -> true), not merely "airborne".
  const watchedAirborne = new Map<string, boolean>();
  let watchTimer: ReturnType<typeof setInterval> | null = null;
  let watchGen = 0;
  const WATCH_POLL_MS = 60_000;

  /** icao24s of watched flights the last poll found airborne (the map draws them distinct). */
  function watchedIcao24s(): Set<string> {
    const out = new Set<string>();
    const status = store.get("watchedStatus");
    for (const key of Object.keys(status)) {
      const row = status[key];
      if (row?.airborne && row.icao24) out.add(row.icao24);
    }
    return out;
  }

  /**
   * Polls every watched flight on the same cheap Swedavia endpoint the Watch
   * panel used to poll (but only while it was open), follows each one that is
   * airborne, and raises the departure toast on the tick it leaves the ground.
   * Runs for the whole session, paused while the tab is hidden.
   */
  async function pollWatched(): Promise<void> {
    const gen = ++watchGen;
    const list = store.get("watchedFlights");
    const prev = store.get("watchedStatus");
    const entries = await Promise.all(
      list.map(async (w) => {
        try {
          const { rows, status } = await searchScheduleWithStatus({ flight: w.flightNumber, date: w.date, airport: w.airport });
          return [watchKey(w), rows.find((r) => r.airport === w.airport) ?? null, status] as const;
        } catch {
          return [watchKey(w), prev[watchKey(w)] ?? null, "incomplete"] as const;
        }
      }),
    );
    if (gen !== watchGen) return;
    const status: Record<string, ScheduledFlight | null> = {};
    const airborneNow = new Set<string>();
    const positionsNow = new Map<string, FlightPosition | null>();
    const fetches: Promise<void>[] = [];
    const departed: WatchedFlight[] = [];
    const notifySamples: { key: string; row: ScheduledFlight; boardStatus: "ok" | "stale" | "incomplete" }[] = [];
    for (const [key, row, boardStatus] of entries) {
      status[key] = row;
      const air = !!(row && row.airborne && row.icao24);
      const was = watchedAirborne.get(key);
      watchedAirborne.set(key, air);
      const icao24 = row?.icao24 ?? null;
      // With the notify flag off, keep the request pattern exactly as it was
      // before this slice: fetch a flight's live position only while it is
      // airborne. The extra fetch for a not-yet-airborne flight exists only to
      // feed the notification detector (the on-ground ticks that prove a
      // landing), so it is gated on the flag instead of being paid for by every
      // default build.
      if (icao24 && (air || NOTIFY_ENABLED)) {
        if (air) airborneNow.add(icao24);
        fetches.push(
          fetchFlightLive(icao24)
            .then((p) => {
              positionsNow.set(icao24, p);
              if (p && air) watchedLive.set(icao24, { ...p, asOf: Date.now() });
            })
            .catch(() => {
              positionsNow.set(icao24, null);
            }),
        );
      }
      if (air && was === false) {
        const w = list.find((x) => watchKey(x) === key);
        if (w) departed.push(w);
      }
      if (NOTIFY_ENABLED && row) notifySamples.push({ key, row, boardStatus });
    }
    await Promise.all(fetches);
    if (gen !== watchGen) return;
    // A flight no longer airborne: drop the position we kept for it.
    for (const icao24 of Array.from(watchedLive.keys())) if (!airborneNow.has(icao24)) watchedLive.delete(icao24);
    store.set("watchedStatus", status);
    renderAircraftLayer();

    if (NOTIFY_ENABLED) {
      const notifyMap = loadNotifyState();
      for (const sample of notifySamples) {
        const position = sample.row.icao24 ? positionsNow.get(sample.row.icao24) ?? null : null;
        const prior = notifyMap[sample.key] ?? emptyState();
        const { state: next, event } = observeFlight(prior, { ...sample, position, nowMs: Date.now() });
        notifyMap[sample.key] = next;
        if (!event) continue;
        const flight = list.find((x) => watchKey(x) === sample.key);
        if (!flight) continue;
        const channel = chooseChannel({ hidden: document.hidden, enabled: next.enabled, permission: notificationPermission() });
        if (channel === "os") {
          void showOsNotification(event.title, event.text, { key: event.key, kind: event.kind });
        } else {
          store.set("watchNotice", { flight, text: event.text, kind: event.kind });
        }
      }
      saveNotifyState(pruneNotifyState(notifyMap));
    } else if (departed.length > 0) {
      store.set("departureToast", departed[0]);
    }
  }

  function startWatchPoll(): void {
    if (watchTimer) clearInterval(watchTimer);
    watchTimer = setInterval(() => {
      if (!document.hidden) void pollWatched();
    }, WATCH_POLL_MS);
    document.addEventListener("visibilitychange", onVisibility);
    void pollWatched();
  }
  function onVisibility(): void {
    if (!document.hidden) void pollWatched();
  }

  /** Select the watched flight's plane and fly the map to it. No-op until it is airborne. */
  function goToWatched(w: WatchedFlight): void {
    const row = store.get("watchedStatus")[watchKey(w)] ?? null;
    if (!row?.airborne || !row.icao24) return;
    const icao24 = row.icao24;
    const known = watchedLive.get(icao24) ?? positions.get(icao24);
    if (known) {
      handleSelectAircraft(known);
      return;
    }
    fetchFlightLive(icao24)
      .then((p) => {
        if (!p) return;
        watchedLive.set(icao24, { ...p, asOf: Date.now() });
        handleSelectAircraft(p);
        renderAircraftLayer();
      })
      .catch(() => {});
  }

  function watchFlight(w: WatchedFlight): void {
    const list = store.get("watchedFlights");
    if (list.some((x) => watchKey(x) === watchKey(w))) return;
    const next = [...list, w];
    saveWatched(next);
    store.set("watchedFlights", next);
    void pollWatched(); // resolve its schedule row now, not on the next tick
  }

  function unwatchFlight(w: WatchedFlight): void {
    const key = watchKey(w);
    const next = store.get("watchedFlights").filter((x) => watchKey(x) !== key);
    saveWatched(next);
    const status = { ...store.get("watchedStatus") };
    delete status[key];
    store.set("watchedStatus", status);
    watchedAirborne.delete(key);
    if (NOTIFY_ENABLED) forgetFlight(key);
    store.set("watchedFlights", next);
  }

  function dismissDepartureToast(): void {
    store.set("departureToast", null);
  }

  function dismissWatchNotice(): void {
    store.set("watchNotice", null);
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
  // Layer order on the map, bottom to top: basemap, airports, the trail,
  // planes, the selected plane (each module adds its layers below the next).
  const mapController = createMap(mapRoot, handleViewportChange, (ready) => store.set("basemapReady", ready));
  const map = mapController.map;
  map.onUserMoveStart(() => {
    userMovedMap = true;
  });
  // ?debug: a read-only diagnostics panel for a misbehaving device (ui/debugOverlay.ts).
  if (new URLSearchParams(location.search).has("debug")) import("./ui/debugOverlay").then((m) => m.mountDebugOverlay(map)).catch(() => {});
  const planeLayer = createPlaneLayer(map, handleSelectAircraft);
  const routeLayer = createRouteLayer(map);
  const uncertaintyLayer = createUncertaintyLayer(map);
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
  store.set("watchFlight", watchFlight);
  store.set("unwatchFlight", unwatchFlight);
  store.set("goToWatched", goToWatched);
  store.set("dismissDepartureToast", dismissDepartureToast);
  store.set("dismissWatchNotice", dismissWatchNotice);

  // ---- UI modules ----
  scaleBar.mount(map);
  import("./ui/defaultAirports").then((mod) => mod.mount(map, handleSelectAirport));
  // Watched, not-yet-airborne flights: their origin airport ringed and labelled.
  import("./ui/watchedAirports").then((mod) => mod.mount(map, store));

  flightSearch.mount(leftOverlayStack, store);
  favoritesPanel.mount(leftOverlayStack, store);
  watchPanel.mount(leftOverlayStack, store);
  legend.mount(leftOverlayStack); // no store slots — its open/closed state is purely local (see ui/legend.ts)
  bootScreen.mount(bootScreenRoot, store);
  resumeDialog.mount(resumeDialogRoot, store);
  dossierPanel.mount(dossierRoot, store);
  watchToast.mount(watchToastRoot, store);

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
  store.subscribe("selectedPos", drawRoute); // the trail ends at the marker, wherever it moves
  map.on("sourcedata", resolveGate); // the gate's tile may arrive after the status
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
  startWatchPoll(); // watched flights, independently of the Watch panel
  if (NOTIFY_ENABLED) {
    // #82 design §2: prune expired notification state on load and once an hour.
    saveNotifyState(pruneNotifyState(loadNotifyState()));
    setInterval(() => saveNotifyState(pruneNotifyState(loadNotifyState())), 60 * 60 * 1000);
  }

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
        if (map.getZoom() !== startZoom || Math.abs(c.lat - startCenter.lat) > 0.01 || Math.abs(c.lon - startCenter.lon) > 0.01) return;
        const center = geo ?? DEFAULT_VIEW;
        const view = summary ? pickInitialView(summary, center, { width: mapRoot.clientWidth, height: mapRoot.clientHeight }) : null;
        if (view) map.setView([view.lat, view.lon], view.zoom);
        // No traffic data to choose a zoom from: still open where the visitor is.
        else if (geo) map.setView([geo.lat, geo.lon], DEFAULT_VIEW.zoom);
      })
      .catch(() => {})
      .finally(() => clearTimeout(timer));
  }

  // Initial viewport report — equivalent to the original ViewportReporter's
  // own mount-time call, fired only now that every layer it can cascade
  // into (markers, clusters, route) exists.
  applyInitialView().then(() => {
    handleViewportChange(boundsFromMap(map), map.getZoom(), true);
    // Tests drive the map only after this (tests/helpers.ts waitForMapReady):
    // until here the opening view can still move it, and its first request
    // would land on top of the test's own.
    mapRoot.dataset.ready = "true";
  });
}

try {
  boot();
} catch (err) {
  // No WebGL2 for the map: say how to turn it on instead of leaving a dead
  // page. createMap is the first thing in boot() that can throw this, before
  // any fetch, timer or live feed has started, so there's nothing to stop.
  if (!(err instanceof GPUInitializationError)) throw err;
  console.error(err);
  webglNotice.mount(document.getElementById("root")!, err.statusMessage);
}
