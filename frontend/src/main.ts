import { Store } from "./state/store";
import type { AppState } from "./state/appState";
import { h, clear } from "./ui/h";
import { loadTheme, saveTheme } from "./theme";
import type { Theme } from "./theme";
import type { FavoriteAircraft, FavoriteRoute } from "./favorites";
import { loadFavoriteAircraft, loadFavoriteRoutes, toggleFavoriteAircraft, toggleFavoriteRoute } from "./favorites";
import type { AirportSelection, Bounds, ClusterPoint, LiveMarker, SelectedPosition } from "./types/flight";
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
    showResumeDialog: false,

    selectedId: null,
    selectedPos: null,
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
  let positions: Record<string, LiveMarker> = {};
  let clusters: ClusterPoint[] = [];

  let cycleStart = Date.now();
  let fetchIntervalTimer: ReturnType<typeof setInterval> | null = null;
  let dialogTimer: ReturnType<typeof setTimeout> | null = null;

  let bounds: Bounds | null = null;
  let zoom = 6;
  let liveRequestSeq = 0;

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
    const list = Object.values(positions);
    const unselectedList = selectedId ? list.filter((p) => p.icao24 !== selectedId) : list;

    const belowServerClusterZoom = zoom < CLUSTER_FETCH_MAX_ZOOM;
    const clientClustered = !belowServerClusterZoom && unselectedList.length > MAX_INDIVIDUAL_MARKERS;

    if (belowServerClusterZoom) clusterLayer.update(clusters);
    else if (clientClustered) clusterLayer.update(clusterPositions(unselectedList, gridDegForZoom(zoom)));
    else clusterLayer.update([]);

    markerLayer.update({
      unselected: clientClustered ? [] : unselectedList,
      selectedPos,
      zoom,
      exiting: belowServerClusterZoom,
    });
  }

  // ---- fetch lifecycle ----
  function applyLiveSnapshot(boundsArg: Bounds | null): Promise<void> {
    const seq = ++liveRequestSeq;
    return fetchLivePositions(boundsArg ?? undefined)
      .then((list) => {
        if (seq !== liveRequestSeq) return; // superseded by a newer request
        const merged: Record<string, LiveMarker> = {};
        for (const p of list) {
          const existing = positions[p.icao24];
          merged[p.icao24] = existing && isNewer(existing, p) ? existing : p;
        }
        positions = merged;
        renderAircraftLayer();
        const selectedId = store.get("selectedId");
        const current = selectedId ? merged[selectedId] : null;
        if (current) {
          const prev = store.get("selectedPos");
          store.set("selectedPos", prev ? { ...prev, ...current } : { ...current, altitudeM: null });
          appendRoutePoint(current);
        }
      })
      .finally(() => store.set("firstLoadDone", true));
  }

  function fetchForZoom(boundsArg: Bounds, zoomArg: number): void {
    if (zoomArg < CLUSTER_FETCH_MAX_ZOOM) {
      fetchLiveClusters(boundsArg, gridDegForZoom(zoomArg))
        .then((c) => {
          clusters = c;
          renderAircraftLayer();
        })
        .catch(() => {})
        .finally(() => store.set("firstLoadDone", true));
      return;
    }
    clusters = [];
    applyLiveSnapshot(boundsArg);
  }

  function fetchFreshData(): void {
    fetchLiveCount()
      .then((n) => store.set("trackedCount", n))
      .catch(() => {});
    if (!bounds) return;
    fetchForZoom(bounds, zoom);
  }

  function handleViewportChange(nextBounds: Bounds, nextZoom: number): void {
    bounds = nextBounds;
    zoom = nextZoom;
    store.set("zoom", nextZoom);
    renderAircraftLayer(); // icon sizes/cluster mode update for the new zoom immediately, independent of the fetch below
    fetchForZoom(nextBounds, nextZoom);
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

    if (dialogTimer) clearTimeout(dialogTimer);
    const dialogDelay = DIALOG_STOP_MS - (Date.now() - cycleStart);
    dialogTimer = setTimeout(() => {
      restartPolling()
        .then((outcome) => {
          if (outcome.rateLimited) {
            store.set("showResumeDialog", true);
          } else {
            cycleStart = Date.now();
            fetchFreshData();
            restartFetchCycleTimers();
          }
        })
        .catch(() => store.set("showResumeDialog", true));
    }, dialogDelay);
  }

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
    function poll(): void {
      fetchFlightLive(icao24)
        .then((p) => {
          if (!p || p.icao24 !== store.get("selectedId")) return;
          const existing = positions[p.icao24];
          if (existing && !isNewer(p, existing)) return; // superseded already
          positions = { ...positions, [p.icao24]: p };
          store.set("selectedPos", p);
          appendRoutePoint(p);
          renderAircraftLayer();
        })
        .catch(() => {});
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
  function handleSelectAircraft(p: LiveMarker): void {
    store.set("airportDossier", null);
    store.set("selectedId", p.icao24); // no-op (and no effect re-run) if already selected — matches the original's state bail-out
    const prevSelectedPos = store.get("selectedPos");
    store.set("selectedPos", prevSelectedPos && prevSelectedPos.icao24 === p.icao24 ? { ...prevSelectedPos, ...p } : { ...p, altitudeM: null });
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
  const mapController = createMap(mapRoot, initialTheme, handleViewportChange);
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
      lat: selectedPos?.latitude ?? null,
      lon: selectedPos?.longitude ?? null,
      sheetExpanded: store.get("dossierExpanded"),
      focusRequest: store.get("focusRequest"),
    });
  }
  store.subscribeMany(["selectedId", "selectedPos", "dossierExpanded", "focusRequest"], syncFollowSelected);

  // ---- per-selection effect wiring ----
  store.subscribe("selectedId", onSelectedIdChanged);
  onSelectedIdChanged(); // selectedId starts null — harmless initial reset

  // ---- mount-only effects ----
  fetchPollingStatus()
    .then((status) => {
      if (!status.active) return restartPolling();
    })
    .catch(() => {});
  fetchLiveCount()
    .then((n) => store.set("trackedCount", n))
    .catch(() => {});

  subscribeLiveFeed((p) => {
    const existing = positions[p.icao24];
    if (existing && !isNewer(p, existing)) return; // superseded by a /live reconcile already
    positions = { ...positions, [p.icao24]: p };
    renderAircraftLayer();
    if (p.icao24 === store.get("selectedId")) {
      store.set("selectedPos", p);
      appendRoutePoint(p);
    }
  });

  restartFetchCycleTimers(); // generation 0

  // Initial viewport report — equivalent to the original ViewportReporter's
  // own mount-time call, fired only now that every layer it can cascade
  // into (markers, clusters, route) exists.
  handleViewportChange(boundsFromMap(map), map.getZoom());
}

boot();
