import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MapContainer, TileLayer, Marker, Polyline, useMap, useMapEvents } from "react-leaflet";
import MarkerClusterGroup from "react-leaflet-cluster";
import L from "leaflet";
// Leaflet's own base stylesheet — was never imported at all before this.
// It defines `.leaflet-marker-icon, .leaflet-pane, .leaflet-tile-pane { }`
// etc. as `position: absolute` (Leaflet's own comment on this block calls
// it out as "required styles"). Without it, every marker/pane falls back
// to being laid out in normal document flow instead of being pinned via
// Leaflet's transform/negative-margin positioning — which is what was
// actually behind aircraft "jumping" and "disappearing" on pan/zoom, and
// the disconnected/zigzagging trails: nothing was wrong with the position
// *data* (confirmed against the live API directly), Leaflet's els just
// weren't absolutely positioned, so unrelated DOM changes (marker count
// changing on every pan, a class toggling on selection, chunked loading
// adding markers over several frames) reflowed everything around them.
import "leaflet/dist/leaflet.css";
import "leaflet.markercluster/dist/MarkerCluster.css";
import "leaflet.markercluster/dist/MarkerCluster.Default.css";
import type { AircraftDossier, Bounds, ClusterPoint, FlightPosition } from "../types/flight";
import {
  fetchAircraftDossier,
  fetchHistory,
  fetchLiveClusters,
  fetchLivePositions,
  fetchPollingStatus,
  restartPolling,
  subscribeLiveFeed,
} from "../api/flightApi";
import FlightSearch from "./FlightSearch";
import ScaleBar from "./ScaleBar";
import "./FlightMap.css";

// The two timers that drive the whole "watch" lifecycle, replacing the old
// manually-controlled poll-window UI (Watch active/stood down, Stop/Resume
// Watch — see startCycle below for the full picture):
//
//   0 ── fetch ── fetch ── fetch ── fetch ── (5min: fetching stops)
//   └──────────────────── 10min: ResumeDialog shown ───────────────────┘
//
// A real /live fetch happens immediately (see ViewportReporter/startCycle)
// and then every FETCH_INTERVAL_MS until FETCH_STOP_MS has elapsed since
// the cycle started. Positions still look live well past that: the
// backend keeps every aircraft's position dead-reckoned forward on its
// own independent schedule (see EstimatedPositionCache.java) regardless
// of whether this frontend is fetching at all — this cadence is purely
// about how often *this client* bothers asking, not about when data goes
// stale. At DIALOG_STOP_MS, ResumeDialog appears; clicking its button
// restarts both timers from zero.
//
// Separately, on mount only, a one-off effect makes sure the backend's own
// hot-poll window (flighttracker.agents.poll-window-seconds, currently
// matched to DIALOG_STOP_MS) is actually open — but only if it's currently
// closed. Someone loading the page while another tab already has it open
// takes no action, so a steady trickle of new visitors can't keep it
// pinned open forever; it's only ever (re)started by an actual page load
// with nothing already running, or an explicit "Resume tracking" click.
const FETCH_INTERVAL_MS = 60_000;
const FETCH_STOP_MS = 5 * 60_000;
const DIALOG_STOP_MS = 10 * 60_000;

const ROUTE_COLOR = "#4db2ff"; // matches --color-accent in FlightMap.css

// A small rotated dart stands in for the transponder icon — heading comes
// straight off the state vector. This used to be the Unicode ✈ glyph
// (U+2708) rotated by a fixed offset to correct for its assumed native
// orientation, but that orientation isn't a fixed, portable fact — it
// depends on whatever font/platform ends up rendering the emoji fallback
// (the element has no font-family of its own), so the "right" offset on
// one machine was visibly wrong on another. An inline SVG path has no such
// ambiguity: authored pointing straight up (north), so rotate(headingDeg)
// with no correction term is always correct by construction.
const PLANE_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true">
  <path d="M12 2 L19 20 L12 16 L5 20 Z" />
</svg>`;

// Unselected markers need to be comfortably tap/click-able, not just
// legible. Selected is larger still, and deliberately — it needs to read
// as clearly the biggest thing at its own position, bigger than a glance
// at the route line passing near/under it (weight: 3 in ROUTE_COLOR's
// pathOptions below) could mistake for the marker itself.
const ICON_SIZE = 30;
const SELECTED_ICON_SIZE = 44;

// Below this, layout switches to the mobile treatment throughout this file
// and FlightMap.css/FlightSearch.css — kept as one shared literal (CSS media
// queries can't reference a JS constant) rather than three independently
// drifting numbers.
const MOBILE_BREAKPOINT_PX = 768;
// 30px comfortably clears mouse-pointer precision but is well under Apple/
// Google's ~44px minimum touch-target guidance — bumped for mobile only,
// so desktop's icon size (and the map's visual density) is untouched.
const MOBILE_ICON_SIZE = 40;
const MOBILE_SELECTED_ICON_SIZE = 54;

// A DivIcon that stamps the current rotation onto its glyph the moment
// Leaflet actually creates the DOM node — which, for a marker inside a
// MarkerClusterGroup with chunkedLoading on, can happen well after the
// marker is constructed: chunked loading defers real icon creation to a
// later setTimeout batch rather than doing it synchronously. Reading
// rotation from a ref (mutated every render, not just on creation) here —
// rather than baking a rotation value into the icon at construction time —
// means whatever the aircraft's heading is *by the time Leaflet gets
// around to it* is what gets painted, instead of whatever it was when the
// React element was first created.
class RotatingPlaneIcon extends L.DivIcon {
  headingRef: { current: number };
  constructor(options: L.DivIconOptions, headingRef: { current: number }) {
    super(options);
    this.headingRef = headingRef;
  }
  createIcon(oldIcon?: HTMLElement) {
    const el = super.createIcon(oldIcon);
    const glyph = el.querySelector<HTMLElement>(".plane-glyph");
    if (glyph) glyph.style.transform = `rotate(${this.headingRef.current}deg)`;
    return el;
  }
}

// known/selected are the only two things that change the icon's
// *structure* (which CSS classes apply) — not heading, which changes on
// almost every position tick. AircraftMarker memoizes this per-marker on
// just those two flags, so react-leaflet's prop diff sees icon ===
// prevIcon (and never calls marker.setIcon()) across ordinary heading
// updates — see AircraftMarker for why that matters far more than it
// sounds like it should. Each marker gets its own icon instance (not
// shared across aircraft) since each needs its own headingRef.
function planeIcon(known: boolean, selected: boolean, headingRef: { current: number }) {
  // Every rotation angle coincides with some real heading, so "just don't
  // rotate it" (or default to any other fixed angle) still misrepresents
  // an unknown heading as a specific real reading. Give unknown headings
  // a distinct outline style instead, independent of rotation, so they
  // can't be mistaken for a confident reading at any angle.
  const glyphClass = known ? "plane-glyph" : "plane-glyph plane-glyph--unknown-heading";
  // The halo lives on a non-rotated wrapper so it stays a circle regardless
  // of the glyph's own rotation.
  //
  // role="img"/aria-label here is deliberately static, not per-aircraft —
  // Leaflet's divIcon sets this string as raw innerHTML, so interpolating
  // callsign (external, attacker-influenceable OpenSky data) into it would
  // be an XSS hole. Per-aircraft detail is only ever rendered through real
  // React DOM (the details panel), which escapes it safely.
  // Sized off `selected`, not just styled — the glyph/halo below fill
  // their parent as percentages (see FlightMap.css) specifically so they
  // scale automatically with whatever size Leaflet applies here, instead
  // of needing a second, separately-sized copy of every child rule.
  // Read directly rather than via a hook: planeIcon is a plain function
  // (called from useMemo, not itself a component), and re-evaluating this
  // per marker on every known/selected change — not on every render — is
  // enough to size correctly for the viewport a marker actually first
  // appears/gets (re)selected in.
  const isMobile = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT_PX}px)`).matches;
  const size = selected
    ? (isMobile ? MOBILE_SELECTED_ICON_SIZE : SELECTED_ICON_SIZE)
    : (isMobile ? MOBILE_ICON_SIZE : ICON_SIZE);
  return new RotatingPlaneIcon(
    {
      className: `plane-icon${selected ? " plane-icon--selected" : ""}`,
      html: `<div class="plane-icon-halo" aria-hidden="true"></div><div class="${glyphClass}" role="img" aria-label="Aircraft position marker">${PLANE_SVG}</div>`,
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2],
    },
    headingRef,
  );
}

function boundsFromMap(map: L.Map): Bounds {
  const b = map.getBounds();
  const lonMin = b.getWest();
  const lonMax = b.getEast();
  // At extreme zoom-out (or after panning across wrapped "copies" of the
  // world), Leaflet's bounds can span or exceed a full 360° of longitude
  // (e.g. -1290..1307) — that's not a real bbox, it's "the whole world is
  // visible". Send the actual valid range in that case rather than
  // nonsensical numbers the backend would just clamp against anyway.
  const spansWholeWorld = lonMax - lonMin >= 360;
  return {
    latMin: Math.max(-90, b.getSouth()),
    latMax: Math.min(90, b.getNorth()),
    lonMin: spansWholeWorld ? -180 : lonMin,
    lonMax: spansWholeWorld ? 180 : lonMax,
  };
}

/**
 * Reports the current map viewport (and zoom, which decides fetch
 * strategy — see CLUSTER_FETCH_MAX_ZOOM) up to the parent — once on
 * mount, and again every time panning/zooming settles (moveend only fires
 * once movement has actually stopped, so this is naturally debounced
 * already, not on every intermediate frame of a drag).
 */
function ViewportReporter({ onViewportChange }: { onViewportChange: (bounds: Bounds, zoom: number) => void }) {
  const map = useMapEvents({
    moveend: () => onViewportChange(boundsFromMap(map), map.getZoom()),
  });
  useEffect(() => {
    onViewportChange(boundsFromMap(map), map.getZoom());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

const SELECTED_MIN_ZOOM = 10;

// At or below this zoom, the map switches from fetching+rendering every
// individual aircraft to fetching server-aggregated grid cells instead
// (see fetchLiveClusters). Measured cause for needing this at all: a
// whole-world viewport can mean 20k+ live aircraft, and turning each one
// into its own React component plus feeding it through
// leaflet.markercluster's per-marker spatial-indexing algorithm blocked
// the main thread for ~2.7s on a single zoom — confirmed via
// PerformanceObserver long-task entries, not a DOM node count problem
// (clustering already kept visible DOM small). Aggregating server-side
// cuts what the client has to fetch *and* render by one to two orders of
// magnitude. 4 is roughly "several countries to a continent" at typical
// screen sizes — comfortably past where individual aircraft are
// distinguishable anyway, and well below where the count becomes a
// problem (regional/country-scale viewports stayed well under a thousand
// aircraft in testing).
const CLUSTER_FETCH_MAX_ZOOM = 4;

// Target minimum on-screen spacing between adjacent grid-cell centers, in
// pixels — sized relative to clusterPointIcon's largest bubble (40px): a
// comfortable ~24px gap between two max-size neighboring bubbles instead
// of them overlapping into an unreadable mass of circles. The previous
// version of this used a fixed degree-size lookup table (6°/4°/2° by
// zoom), which gave only ~17-23px of spacing at low zoom against 24-40px
// bubbles — the overlapping-circles mess reported was that table being
// wrong, not a rendering bug.
const CLUSTER_TARGET_SPACING_PX = 64;

// Computed from Web Mercator's actual pixels-per-degree-of-longitude at a
// given zoom (256 * 2^zoom / 360 — constant across latitude, unlike
// pixels-per-degree-of-*latitude*, which Mercator stretches near the
// poles; sizing off longitude's constant scale means cells are *at least*
// this well-spaced everywhere, not just at the equator) rather than a
// fixed lookup table: screen density doubles with every zoom step, so a
// table of fixed degree sizes can only ever be right at one zoom level.
function gridDegForZoom(zoom: number): number {
  const pxPerDegree = (256 * 2 ** zoom) / 360;
  return CLUSTER_TARGET_SPACING_PX / pxPerDegree;
}

// Past this, "last updated" reads as a warning rather than routine network
// jitter — matches DIALOG_STOP_MS/poll-window-seconds elsewhere, the same
// "10 minutes of nothing is genuinely notable" threshold — short enough to
// flag an aircraft that's gone quiet (out of ADS-B coverage, landed
// somewhere without ground receivers, etc.) well before the 4h
// staleAirborneCutoff that would eventually drop it from the map entirely.
const STALE_POSITION_WARN_MS = 10 * 60_000;

function formatAgo(observedAtIso: string, nowMs: number): string {
  const elapsedMs = Math.max(0, nowMs - new Date(observedAtIso).getTime());
  const seconds = Math.round(elapsedMs / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return `${hours}h ago`;
}

/** "Xh Ym" for >=60 minutes, otherwise just "Xm" — dossier's flight-time/ETA display. */
function formatDurationMinutes(totalMinutes: number): string {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

// Matches AircraftDossier.flightPhase's possible values (see
// FlightPhaseClassifier.FlightPhase on the backend) to a human label.
const FLIGHT_PHASE_LABELS: Record<string, string> = {
  ON_GROUND: "On ground",
  TAKING_OFF: "Taking off",
  CLIMBING: "Climbing",
  LEVEL: "Level",
  DESCENDING: "Descending",
  LANDING: "Landing",
};

function formatFlightPhase(phase: string | null): string {
  if (!phase) return "—";
  return FLIGHT_PHASE_LABELS[phase] ?? phase;
}

function FollowSelected({
  selectedId,
  lat,
  lon,
  sheetExpanded,
}: {
  selectedId: string | null;
  lat: number | null;
  lon: number | null;
  // Mobile bottom-sheet collapsed/expanded state (see FlightMap.css's
  // ≤768px block) — irrelevant to desktop's layout, but on mobile the map
  // container's actual on-screen height changes when this toggles (the
  // sheet is a real flex sibling now, not an overlay — see .details-panel),
  // so this needs to be a dependency here too: without it, toggling the
  // sheet would leave the map still centered on wherever it was framed for
  // the *previous* map height, which is exactly the "plane hidden behind
  // the sheet" bug this replaces.
  sheetExpanded: boolean;
}) {
  const map = useMap();
  // Distinguishes "just selected a different aircraft" (zoom in and
  // center on it) from "the already-selected aircraft moved, or the
  // available map area changed" (keep it centered/re-centered, but leave
  // the user's current zoom alone) — both re-center the view, but flyTo's
  // zoom bump on every ordinary position tick would otherwise keep
  // yanking the view back to SELECTED_MIN_ZOOM even after the user
  // deliberately zoomed out further to see more context around it.
  const lastCenteredIdRef = useRef<string | null>(null);

  useEffect(() => {
    // Leaflet caches the container's last-known size and won't repaint
    // tiles/markers to fit a new one on its own — needed both when the
    // sheet just mounted/changed height (map-container shrank or grew as
    // its flex sibling) and when it just unmounted (map-container grew
    // back to full height). A no-op when the size genuinely hasn't
    // changed, so unconditional here is fine.
    map.invalidateSize();
    if (selectedId == null) {
      lastCenteredIdRef.current = null;
      return;
    }
    if (lat == null || lon == null) return;
    if (lastCenteredIdRef.current !== selectedId) {
      lastCenteredIdRef.current = selectedId;
      map.flyTo([lat, lon], Math.max(map.getZoom(), SELECTED_MIN_ZOOM), { animate: true, duration: 0.8 });
    } else {
      // lat/lon here are two of the dependencies that actually vary tick
      // to tick (unlike a `[lat, lon]` tuple prop, which would be a fresh
      // array reference — and so a "changed" dependency — on every parent
      // render regardless of whether the position itself moved).
      map.panTo([lat, lon], { animate: true, duration: 0.5 });
    }
  }, [selectedId, lat, lon, map, sheetExpanded]);
  return null;
}

// Renders one aircraft's marker. Split out (and memoized) so a position
// update for aircraft A doesn't re-render aircraft B's marker — without
// this, every single websocket tick re-rendered the *entire* marker list,
// which (via the icon churn described in planeIcon above) meant every
// marker's icon DOM got torn down and rebuilt on every redraw, for any
// aircraft's update, selected or not. No popup here — clicking a marker
// already opens the aircraft details panel, which covers the same fields.
const AircraftMarker = memo(function AircraftMarker({
  position,
  selected,
  onSelect,
}: {
  position: FlightPosition;
  selected: boolean;
  onSelect: (p: FlightPosition) => void;
}) {
  const markerRef = useRef<L.Marker | null>(null);
  const known = position.headingDeg != null;
  const rotationDeg = known ? (position.headingDeg as number) : 0;

  // Kept current on every render (not just in an effect) so that whenever
  // RotatingPlaneIcon.createIcon() actually runs — synchronously or, under
  // MarkerClusterGroup's chunkedLoading, an arbitrary async batch later —
  // it reads the most recent heading rather than whatever was current when
  // the icon object was constructed.
  const headingRef = useRef(rotationDeg);
  headingRef.current = rotationDeg;

  const icon = useMemo(() => planeIcon(known, selected, headingRef), [known, selected]);

  // Handles the ordinary case: an already-mounted marker whose aircraft's
  // heading changes on a later position tick. Applied directly to the
  // mounted glyph element rather than by giving it a new `icon` — doing it
  // this way means a heading change never touches the `icon` prop, so it
  // never triggers Marker.setIcon(), which would otherwise tear down and
  // rebuild the icon DOM on every single position tick.
  useEffect(() => {
    const glyph = markerRef.current?.getElement()?.querySelector<HTMLElement>(".plane-glyph");
    if (glyph) glyph.style.transform = `rotate(${rotationDeg}deg)`;
  }, [rotationDeg]);

  return (
    <Marker
      ref={markerRef}
      position={[position.latitude, position.longitude]}
      icon={icon}
      eventHandlers={{ click: () => onSelect(position) }}
    />
  );
});

// Cell size steps roughly with count so a cell holding hundreds of
// aircraft doesn't look identical to one holding two — deliberately not
// precise (three buckets, not a continuous formula), since at the zoom
// level this renders at that's plenty of visual distinction.
function clusterPointIcon(count: number) {
  const size = count >= 100 ? 40 : count >= 15 ? 32 : 24;
  return L.divIcon({
    className: "cluster-point-icon",
    html: `<div class="cluster-point-bubble">${count}</div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

// One aggregated grid cell at the zoomed-way-out view — see
// CLUSTER_FETCH_MAX_ZOOM. No click handler: a cell isn't one aircraft,
// there's nothing meaningful for it to select. Memoized for the same
// reason as AircraftMarker, though it matters far less here — a few
// hundred cells is already well within a normal render budget on its own.
const ClusterPointMarker = memo(function ClusterPointMarker({ point }: { point: ClusterPoint }) {
  const icon = useMemo(() => clusterPointIcon(point.count), [point.count]);
  return <Marker position={[point.lat, point.lon]} icon={icon} interactive={false} />;
});

export default function FlightMap() {
  const [positions, setPositions] = useState<Record<string, FlightPosition>>({});
  const [selected, setSelected] = useState<string | null>(null);
  // Captured at click time and kept live-updated by the WebSocket feed and
  // the periodic reconcile below, but — unlike a plain positions[selected]
  // lookup — never nulled out just because the aircraft momentarily isn't
  // in the live set. A user looking at one aircraft's details is exactly
  // the wrong moment for it to vanish from under them (e.g. right as it
  // crosses into "landed" and briefly races the next reconcile).
  const [selectedPos, setSelectedPos] = useState<FlightPosition | null>(null);
  // Mobile-only bottom-sheet state (see the ≤768px block in FlightMap.css):
  // collapsed shows just the summary + an expand toggle; expanded also
  // shows the fields grid. Irrelevant above the breakpoint — the CSS driven
  // by this class only does anything inside that media query. Reset to
  // collapsed on every new selection (handleSelect below) so a previous
  // aircraft's expanded state doesn't carry over to the next one.
  const [dossierExpanded, setDossierExpanded] = useState(false);
  // Ticked every second while an aircraft is selected, purely to force the
  // details panel's "last updated" line to re-render as time passes —
  // selectedPos.observedAt itself doesn't change between real updates, so
  // without this the display would only advance when a new position
  // actually arrived, defeating the point of showing staleness at all.
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [route, setRoute] = useState<[number, number][]>([]);
  const [dossier, setDossier] = useState<AircraftDossier | null>(null);

  // When the current fetch cycle began — see startCycle below. A ref, not
  // state: read inside setInterval closures, never itself needs to
  // trigger a render (cycleGeneration does that instead).
  const cycleStartRef = useRef(Date.now());
  // Bumped by startCycle to force the fetch-interval and dialog-timer
  // effects (both keyed on this) to tear down and restart cleanly, rather
  // than trying to reset already-running setInterval timers in place.
  const [cycleGeneration, setCycleGeneration] = useState(0);
  // Shown once DIALOG_STOP_MS has elapsed since cycleStartRef — see
  // ResumeDialog below. Replaces the old Watch active/stood down badge
  // and Stop/Resume Watch buttons entirely: there's no manual stop
  // anymore, only the automatic lifecycle and this one resume action.
  const [showResumeDialog, setShowResumeDialog] = useState(false);

  // The live feed subscription below is set up once and outlives every
  // selection change, so its closure can't see updates to `selected` —
  // a ref is how it reads the current value without resubscribing (and
  // re-opening the WebSocket) on every click.
  const selectedRef = useRef<string | null>(null);
  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);

  // Mirrors selectedPos for the same reason as selectedRef above — read by
  // the history-fetch effect below to bridge the gap between where the
  // trail (real data only) ends and wherever the aircraft is actually
  // shown right now (which may already be a server-side dead-reckoned
  // position — see EstimatedPositionCache.java), without making that
  // effect depend on (and re-run history fetches for) every selectedPos
  // update in between.
  const selectedPosRef = useRef<FlightPosition | null>(null);
  useEffect(() => {
    selectedPosRef.current = selectedPos;
  }, [selectedPos]);

  // Tracking is global now, but the map only ever wants what's currently
  // visible — this is that viewport, kept in a ref (not state) so the
  // reconcile interval below always reads the latest value from its
  // closure without needing to be torn down and rebuilt on every pan.
  const boundsRef = useRef<Bounds | null>(null);

  // Current zoom, kept both ways: a ref alongside boundsRef so the
  // reconcile interval can read it without being torn down and rebuilt on
  // every zoom step, and state so the individual-vs-clustered rendering
  // choice below re-renders when it crosses CLUSTER_FETCH_MAX_ZOOM.
  const zoomRef = useRef(6);
  const [zoom, setZoom] = useState(6);

  const [clusterPoints, setClusterPoints] = useState<ClusterPoint[]>([]);
  const clusterRequestSeqRef = useRef(0);

  // Mirrors `positions` synchronously (state updates aren't readable
  // mid-render, but applyLiveSnapshot below needs the current value the
  // instant its fetch resolves, not a render cycle later) — see its use
  // there for why.
  const positionsRef = useRef<Record<string, FlightPosition>>({});

  // A live aircraft's position reaches this component two ways that race
  // each other with no ordering guarantee: pushed over the WebSocket the
  // moment the backend receives it, or fetched via /live — which every
  // pan/zoom re-triggers (see handleViewportChange) and which reflects
  // whatever was in the database at *query* time. The DB row itself never
  // regresses (the backend's upsert only lets it move forward), but the
  // client-side *arrival order* of these two paths is unordered: a /live
  // response can easily land after a WebSocket push that was already newer
  // than what that response was queried from. Applying whichever arrives
  // last unconditionally — the previous behavior — let a stale REST
  // snapshot silently overwrite a fresher WebSocket-delivered position,
  // which showed up as a marker (and the selected aircraft's trail)
  // visibly jumping backward on every pan/zoom, since each one fires a
  // fresh /live request. observedAt is what actually orders these, not
  // arrival time, so every write path compares against it before applying.
  function isNewer(a: FlightPosition, b: FlightPosition) {
    return a.observedAt > b.observedAt;
  }

  // /live requests race: a wide (slow, lots of rows) query fired first can
  // resolve *after* a narrower (fast) one fired later — e.g. zooming out
  // through several intermediate viewports in quick succession. Without a
  // sequence guard, whichever response lands last wins regardless of which
  // viewport it was actually for, so a stale narrow snapshot could silently
  // clobber the correct wide one and make it look like only a small region
  // had any traffic. Bumped once per request; a response is only applied
  // if it's still the most recently *issued* one.
  const liveRequestSeqRef = useRef(0);

  // observedAt of whatever's currently the trail's last point, so a late-
  // arriving but chronologically-older report (see isNewer above) gets
  // rejected instead of appended out of order. Reset alongside `route`
  // itself in the selection-change effect below.
  const lastRouteObservedAtRef = useRef<string | null>(null);

  // Appends a point to the selected aircraft's trail. Shared between the
  // WebSocket push handler and applyLiveSnapshot's REST reconcile below —
  // both can hand this a fresher position for the selected aircraft, and
  // both need to keep the trail in sync with it.
  function appendRoutePoint(p: FlightPosition) {
    // Strictly-older only, not <= : the server can report an updated
    // position for the same last-known fix without observedAt itself
    // advancing (e.g. a dead-reckoned estimate the backend has projected
    // further forward since the last time this aircraft was fetched — see
    // EstimatedPositionCache.java; the frontend has no way to know that's
    // what happened, and doesn't need to). Rejecting "equal" here would
    // silently drop that kind of update, leaving the trail's last point
    // stuck behind wherever the marker itself has since moved to. Genuine
    // identical-timestamp duplicates are still a no-op: the coordinate
    // check right below catches those.
    if (lastRouteObservedAtRef.current != null && p.observedAt < lastRouteObservedAtRef.current) return;
    lastRouteObservedAtRef.current = p.observedAt;
    setRoute((prev) => {
      const last = prev[prev.length - 1];
      if (last && last[0] === p.latitude && last[1] === p.longitude) return prev;
      return [...prev, [p.latitude, p.longitude]];
    });
  }

  function applyLiveSnapshot(bounds: Bounds | null) {
    const seq = ++liveRequestSeqRef.current;
    return fetchLivePositions(bounds ?? undefined).then((list) => {
      if (seq !== liveRequestSeqRef.current) return; // superseded by a newer request
      const merged: Record<string, FlightPosition> = {};
      for (const p of list) {
        const existing = positionsRef.current[p.icao24];
        // The REST snapshot itself defines who's currently live/visible
        // (additions and removals both come from it) — this only guards
        // against regressing an entry present in *both* to older data,
        // when a WebSocket push has already delivered something newer for
        // it since this request went out. "Newer," not "strictly newer
        // than `existing`" would reject: the server can legitimately
        // return an updated position for the same last-known fix without
        // observedAt advancing (see appendRoutePoint's comment on why) —
        // isNewer(existing, p) only rejects `p` when existing is
        // *strictly* ahead, so a same-timestamp update from the server
        // still wins here instead of losing to a stale cached `existing`.
        merged[p.icao24] = existing && isNewer(existing, p) ? existing : p;
      }
      positionsRef.current = merged;
      setPositions(merged);
      const current = selectedRef.current ? merged[selectedRef.current] : null;
      if (current) {
        setSelectedPos(current);
        appendRoutePoint(current);
      }
    });
  }

  // The clustered counterpart to applyLiveSnapshot. No observedAt/recency
  // guarding here the way positions/route have — a cluster point isn't a
  // single aircraft with a timeline, it's a fresh count every request, so
  // there's nothing to regress relative to. Only the request-sequence
  // guard (same reasoning as liveRequestSeqRef) applies.
  function applyClusterSnapshot(bounds: Bounds, zoom: number) {
    const seq = ++clusterRequestSeqRef.current;
    return fetchLiveClusters(bounds, gridDegForZoom(zoom)).then((points) => {
      if (seq !== clusterRequestSeqRef.current) return; // superseded by a newer request
      setClusterPoints(points);
    });
  }

  function fetchFreshData() {
    if (!boundsRef.current) return;
    if (zoomRef.current <= CLUSTER_FETCH_MAX_ZOOM) {
      applyClusterSnapshot(boundsRef.current, zoomRef.current);
    } else {
      applyLiveSnapshot(boundsRef.current);
    }
  }

  function handleViewportChange(bounds: Bounds, newZoom: number) {
    boundsRef.current = bounds;
    zoomRef.current = newZoom;
    setZoom(newZoom);
    if (newZoom <= CLUSTER_FETCH_MAX_ZOOM) {
      applyClusterSnapshot(bounds, newZoom);
    } else {
      applyLiveSnapshot(bounds);
    }
  }

  /**
   * (Re)starts the whole watch lifecycle: an immediate fresh fetch, then
   * fresh fetches every FETCH_INTERVAL_MS until FETCH_STOP_MS has elapsed
   * (see the cycle effect below), after which ResumeDialog appears at
   * DIALOG_STOP_MS — this is what its button calls to start over.
   *
   * restartPolling() is a best-effort, silent call to (re)open the backend
   * agent's own hot-poll window (see AgentController/PollWindowService) —
   * without it, fresh fetches here would just be re-reading whatever the
   * multi-minute global sweep last wrote. Unconditional here is correct:
   * this only runs from an explicit "Resume tracking" click, which by
   * definition means the previous window already lapsed, so there's
   * nothing live to disturb. Failures (including the agent's own
   * independent rate limit) are deliberately swallowed: there's no status
   * text left to show them in, and a fetch happens regardless either way —
   * between real reports, the backend keeps every position looking current
   * on its own regardless (see EstimatedPositionCache.java).
   */
  function startCycle() {
    cycleStartRef.current = Date.now();
    setShowResumeDialog(false);
    restartPolling().catch(() => {});
    fetchFreshData();
    setCycleGeneration((g) => g + 1);
  }

  /**
   * Mount-only: makes sure the backend's hot-poll window is actually
   * running, without touching one that already is. A page load isn't the
   * same as someone asking to (re)start — if another tab already has the
   * window open, this one loading shouldn't reset its countdown, or every
   * new visitor arriving while a session is live would keep re-extending
   * it forever regardless of whether anyone's still watching. Contrast
   * with startCycle() above, whose unconditional restartPolling() call is
   * correct there specifically because it only fires on an explicit resume
   * action. Silent/best-effort for the same reason restartPolling() itself
   * is: no status text to show a failure in, and the map still works off
   * the global sweep either way.
   */
  useEffect(() => {
    fetchPollingStatus()
      .then((status) => {
        if (!status.active) return restartPolling();
      })
      .catch(() => {});
  }, []);

  // Fresh-data fetches: immediately (handled by ViewportReporter's mount
  // report for generation 0; startCycle's own direct call for every later
  // generation) and then every FETCH_INTERVAL_MS, until FETCH_STOP_MS has
  // elapsed since this cycle began.
  useEffect(() => {
    const interval = setInterval(() => {
      if (Date.now() - cycleStartRef.current >= FETCH_STOP_MS) {
        clearInterval(interval);
        return;
      }
      fetchFreshData();
    }, FETCH_INTERVAL_MS);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cycleGeneration]);

  // ResumeDialog appears once DIALOG_STOP_MS has elapsed since this cycle
  // began — a single check, not a repeating tick, since nothing here needs
  // to happen in between.
  useEffect(() => {
    const timeout = setTimeout(() => {
      setShowResumeDialog(true);
    }, DIALOG_STOP_MS - (Date.now() - cycleStartRef.current));
    return () => clearTimeout(timeout);
  }, [cycleGeneration]);

  useEffect(() => {
    const unsubscribe = subscribeLiveFeed((p) => {
      const existing = positionsRef.current[p.icao24];
      if (existing && !isNewer(p, existing)) return; // superseded by a /live reconcile already
      setPositions((prev) => {
        const next = { ...prev, [p.icao24]: p };
        positionsRef.current = next;
        return next;
      });
      if (p.icao24 === selectedRef.current) {
        setSelectedPos(p);
        appendRoutePoint(p);
      }
    });
    return unsubscribe;
  }, []);

  // Only runs while an aircraft is actually selected — nothing reads
  // nowMs otherwise, so ticking it in the background would just be wasted
  // renders.
  useEffect(() => {
    if (!selected) return;
    const interval = setInterval(() => setNowMs(Date.now()), 1_000);
    return () => clearInterval(interval);
  }, [selected]);

  useEffect(() => {
    // Neither fetchHistory nor fetchAircraftDossier below was cancelled on
    // a fast second selection change — switch from aircraft A to B, then
    // to C before A's history request resolves, and A's response would
    // still land and unconditionally overwrite C's already-correct route
    // with A's entirely unrelated one (same for the dossier fields). Two
    // real aircraft's paths splicing together like that is exactly what
    // produced the disconnected, zigzagging trails reported — the route
    // data itself checks out clean (verified against the live API: every
    // aircraft's raw history is chronologically ordered with physically
    // plausible speeds throughout), so the corruption was happening here,
    // client-side, not in what the backend returned. `cancelled` is this
    // effect's own local flag, closed over by both .then() handlers below,
    // and flipped in the cleanup that runs the instant `selected` changes
    // again (or the component unmounts) — so a response arriving after
    // that point is simply dropped instead of applied.
    let cancelled = false;

    // Cleared unconditionally, not just on deselect: switching directly
    // from aircraft A to B never passes through "selected = null", so
    // without this the polyline kept showing A's route — and could even
    // grow a stray point onto it — during the gap before B's history fetch
    // below resolves (the live-feed effect appends to `route` the moment a
    // new position for whichever aircraft is now selected arrives, which
    // can easily win that race).
    setRoute([]);
    // Reset alongside `route`: otherwise this still holds the *previous*
    // aircraft's last observedAt, and appendRoutePoint's recency guard
    // would wrongly reject the newly-selected aircraft's own points as
    // "stale" just for having an earlier timestamp than the old one.
    lastRouteObservedAtRef.current = null;
    if (!selected) {
      setDossier(null);
      setSelectedPos(null);
      return;
    }
    const to = new Date().toISOString();
    const from = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(); // last 6h of history
    fetchHistory(selected, from, to).then((track) => {
      if (cancelled) return; // superseded by a newer selection since this was requested
      if (track.length > 0) lastRouteObservedAtRef.current = track[track.length - 1].observedAt;
      setRoute(track.map((p) => [p.latitude, p.longitude]));
      // /history only ever has real reports (see FlightController.history)
      // — it stops at the last one, which can already be well behind
      // wherever this aircraft is actually being shown (selectedPos may
      // be a server-side dead-reckoned position ahead of it). Without
      // this, the trail visibly stopped short of the marker with no
      // connecting segment, and stayed that way until some later live
      // update happened to extend it — which might be a long time, given
      // this aircraft might not even be inside the current viewport.
      if (selectedPosRef.current) appendRoutePoint(selectedPosRef.current);
    });
    setDossier(null); // clear the previous aircraft's fields while the new lookup is in flight
    // Best-effort: a failed lookup just leaves the dossier fields at their
    // "—" fallback rather than surfacing an error — this is enrichment,
    // not core data, and shouldn't block the zoom/panel from working.
    fetchAircraftDossier(selected)
      .then((d) => { if (!cancelled) setDossier(d); })
      .catch(() => { if (!cancelled) setDossier(null); });

    return () => {
      cancelled = true;
    };
  }, [selected]);

  // Stable across renders (setSelected/setSelectedPos identities never
  // change) so it doesn't defeat AircraftMarker's memoization the way a
  // freshly-allocated closure passed as a prop would.
  const handleSelect = useCallback((p: FlightPosition) => {
    setSelected(p.icao24);
    setSelectedPos(p);
    setDossierExpanded(false);
  }, []);

  const list = Object.values(positions);
  // Excluded from whatever feeds MarkerClusterGroup (and, at cluster-summary
  // zoom, never part of clusterPoints in the first place — those are
  // server-aggregated counts, not individual aircraft) — the selected
  // aircraft always renders as its own standalone marker instead, see
  // below. Otherwise zooming out could fold it into a cluster bubble, or
  // at cluster-summary zoom drop it from the map entirely, right as a user
  // is trying to keep an eye on it.
  const unselectedList = selected ? list.filter((p) => p.icao24 !== selected) : list;

  return (
    <div className="app-shell">
      <FlightSearch onSelect={handleSelect} />
      <header className="app-header">
        <h1>Flight Tracker</h1>
        <p className="app-header-subtitle">Live aircraft positions</p>
      </header>

      {showResumeDialog && (
        <div className="resume-dialog-backdrop" role="presentation">
          <div className="resume-dialog" role="dialog" aria-modal="true" aria-labelledby="resume-dialog-heading">
            <h2 id="resume-dialog-heading">Tracking paused</h2>
            <p>Live tracking has been stopped to save bandwidth.</p>
            <button className="resume-dialog-button" onClick={startCycle}>Resume tracking</button>
          </div>
        </div>
      )}

      <MapContainer
        center={[59.33, 18.06]}
        zoom={6}
        minZoom={2}
        // Past this, the world starts wrapping into multiple side-by-side
        // copies — Leaflet's own marker projection gets confused about
        // which copy a marker belongs to at that point (real aircraft ended
        // up rendered far outside the visible map), and getBounds() reports
        // a longitude span that isn't a real bbox at all. minZoom keeps the
        // view to a single, unambiguous world.
        className="map-container"
        zoomControl={false}
        aria-label="Live aircraft map"
      >
        <TileLayer
          attribution='&copy; OpenStreetMap contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        {/* Metric only — every other distance in this app (altitude in m,
            speed in km/h) is metric, so a scale bar switching to miles/ft
            would be the odd one out. A multi-segment physical-cm ruler
            (see ScaleBar.tsx) rather than Leaflet's default single
            variable-width bar — a browser has no reliable way to know a
            display's true physical DPI, so "1cm" here is nominal (the
            CSS 96px/in definition), same caveat every such web ruler has. */}
        <ScaleBar />
        <ViewportReporter onViewportChange={handleViewportChange} />
        <FollowSelected
          selectedId={selected}
          lat={selectedPos?.latitude ?? null}
          lon={selectedPos?.longitude ?? null}
          sheetExpanded={dossierExpanded}
        />

        {route.length > 1 && (
          <Polyline positions={route} className="route-line" pathOptions={{ color: ROUTE_COLOR, weight: 3, dashArray: "6 8" }} />
        )}

        {zoom <= CLUSTER_FETCH_MAX_ZOOM ? (
          // A continent or the whole world can mean 20k+ live aircraft.
          // Turning each into its own React component and feeding it
          // through leaflet.markercluster's per-marker spatial-indexing
          // algorithm was the actual cost (confirmed: the backend answers
          // a whole-world bbox in ~60ms; it was 2+ seconds of client-side
          // work that made zooming out feel stuck, not the visible marker
          // count — clustering already kept that small). Below
          // CLUSTER_FETCH_MAX_ZOOM the server aggregates instead (see
          // fetchLiveClusters), so there are only a few hundred to low
          // thousands of cells to render here — few enough that plain
          // markers, no client-side clustering pass needed, are plenty.
          clusterPoints.map((c) => <ClusterPointMarker key={`${c.lat}:${c.lon}`} point={c} />)
        ) : (
          <MarkerClusterGroup
            chunkedLoading
            maxClusterRadius={70}
            disableClusteringAtZoom={SELECTED_MIN_ZOOM}
            showCoverageOnHover={false}
          >
            {unselectedList.map((p) => (
              <AircraftMarker key={p.icao24} position={p} selected={false} onSelect={handleSelect} />
            ))}
          </MarkerClusterGroup>
        )}

        {/* Rendered outside both branches above (and outside
            MarkerClusterGroup specifically) so the selected aircraft is
            never clustered — not into a bubble by leaflet.markercluster,
            and not dropped off the map entirely at cluster-summary zoom,
            where clusterPoints holds only aggregated counts.
            Caveat: at cluster-summary zoom (zoom <= CLUSTER_FETCH_MAX_ZOOM)
            selectedPos itself can go stale. applyClusterSnapshot doesn't
            touch it, and the WebSocket feed is filtered server-side by
            whatever viewport was last *reported* — which the cluster
            endpoint deliberately never does (see its controller-side
            comment) — so a selected aircraft that moves outside the last
            individual-mode viewport while zoomed out this far stops
            getting live updates until the user zooms back in. FollowSelected
            still pans to wherever selectedPos last was; it just won't be
            the aircraft's true current position in that scenario. */}
        {selectedPos && <AircraftMarker position={selectedPos} selected onSelect={handleSelect} />}
      </MapContainer>

      {selectedPos && (
        <aside
          className={`details-panel${dossierExpanded ? " details-panel--expanded" : ""}`}
          aria-labelledby="details-panel-heading"
        >
          {/* Mobile-only (see FlightMap.css) — replaces the bottom Close
              button from the sheet's usual corner instead, matching the
              standard mobile-sheet dismiss pattern; the desktop side panel
              keeps its existing bottom Close button unchanged. */}
          <button className="details-panel-close-x" onClick={() => setSelected(null)} aria-label="Close aircraft details">
            ✕
          </button>
          <div className="details-panel-inner">
            <span className="details-panel-eyebrow" id="details-panel-heading">Aircraft Details</span>
            <h2>{selectedPos.callsign?.trim() || selectedPos.icao24.toUpperCase()}</h2>
            <p className="details-panel-meta">ICAO24 {selectedPos.icao24.toUpperCase()} · last leg traced above</p>
            {(() => {
              const stale = nowMs - new Date(selectedPos.observedAt).getTime() > STALE_POSITION_WARN_MS;
              // dossier.staleExplanation (AircraftController.describeLikelyStatus)
              // is the actual reasoning — flight phase (from a real
              // altitude trend) plus distance to the destination airport,
              // not a blanket "probably landed" the moment data goes old.
              // A real report over open water, still flagged airborne and
              // at cruise, reads as a coverage gap there, not a landing —
              // the earlier flat "likely landed" guess here got that
              // exact case wrong. Falls back to a neutral line if the
              // dossier hasn't loaded yet (e.g. right after selecting).
              return (
                <p className={`details-panel-updated${stale ? " details-panel-updated--stale" : ""}`}>
                  {stale ? "⚠ " : ""}
                  Last updated {formatAgo(selectedPos.observedAt, nowMs)}
                  {stale && ` — ${dossier?.staleExplanation ?? "no recent updates"}`}
                </p>
              );
            })()}
            <dl className="details-panel-fields">
              <dt>Type</dt><dd>{dossier?.model || "—"}</dd>
              <dt>Registration</dt><dd>{dossier?.registration || "—"}</dd>
              <dt>Operator</dt><dd>{dossier?.operator || "—"}</dd>
              <dt>Origin</dt><dd>{dossier?.originAirportName || dossier?.originAirport || "—"}</dd>
              <dt>Destination</dt><dd>{dossier?.destinationAirportName || dossier?.destinationAirport || "—"}</dd>
              <dt>Phase</dt><dd>{formatFlightPhase(dossier?.flightPhase ?? null)}</dd>
              <dt>Altitude</dt>
              <dd>{selectedPos.altitudeM != null ? `${Math.round(selectedPos.altitudeM)} m` : "—"}</dd>
              <dt>Cruising altitude</dt>
              <dd>{dossier?.cruisingAltitudeM != null ? `${Math.round(dossier.cruisingAltitudeM)} m` : "—"}</dd>
              <dt>Flight time</dt>
              <dd>{dossier?.flightMinutes != null ? formatDurationMinutes(dossier.flightMinutes) : "—"}</dd>
              <dt>ETA</dt>
              <dd>{dossier?.etaMinutes != null ? formatDurationMinutes(dossier.etaMinutes) : "—"}</dd>
            </dl>
            {/* Mobile-only. Placed after .details-panel-fields deliberately:
                that keeps this immediately below the visible content in
                both states — while collapsed the fields grid is display:none
                (zero height) so this sits right after the summary; while
                expanded it sits at the true end of the content, below the
                now-visible fields. */}
            <button
              className="details-panel-expand-toggle"
              onClick={() => setDossierExpanded((v) => !v)}
              aria-expanded={dossierExpanded}
              aria-label={dossierExpanded ? "Show less" : "Show more"}
            >
              {dossierExpanded ? "▲" : "▼"}
            </button>
            <button className="details-panel-close" onClick={() => setSelected(null)} aria-label="Close aircraft details">
              Close
            </button>
          </div>
        </aside>
      )}
    </div>
  );
}
