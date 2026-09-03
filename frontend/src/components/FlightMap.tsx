import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MapContainer, TileLayer, Marker, Polyline, useMap, useMapEvents } from "react-leaflet";
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
import type { AircraftDossier, AirportInfo, Bounds, ClusterPoint, FlightPosition, LiveMarker, SelectedPosition } from "../types/flight";
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
} from "../api/flightApi";
import type { AirportSelection } from "./VectorBasemap";
import FlightSearch from "./FlightSearch";
import FavoritesPanel from "./FavoritesPanel";
import Legend from "./Legend";
import Dock from "./Dock";
import BootScreen from "./BootScreen";
import ThemeToggle from "./ThemeToggle";
// Lazy-loaded so worldMapData.ts's 226KB of embedded Natural Earth
// geometry — only ever needed for the cyberpunk theme — isolates into
// its own async chunk instead of bloating the main bundle default-theme
// users pay for on every load.
const VectorBasemap = lazy(() => import("./VectorBasemap"));
import ScaleBar from "./ScaleBar";
import "./FlightMap.css";
import type { FavoriteAircraft, FavoriteRoute } from "../favorites";
import { isAircraftFavorited, isRouteFavorited, loadFavoriteAircraft, loadFavoriteRoutes, toggleFavoriteAircraft, toggleFavoriteRoute } from "../favorites";
import type { Theme } from "../theme";
import { loadTheme, saveTheme } from "../theme";

// The two timers that drive the whole "watch" lifecycle, replacing the old
// manually-controlled poll-window UI (Watch active/stood down, Stop/Resume
// Watch — see startCycle below for the full picture):
//
//   0 ── fetch ── fetch ── fetch ── fetch ── (5min: try a silent renewal)
//                                              │
//                                    still has today's allowance? ── yes ── cycle restarts, loop continues
//                                              │
//                                              no
//                                              │
//                                     ResumeDialog shown
//
// A real /live fetch happens immediately (see ViewportReporter/startCycle)
// and then every FETCH_INTERVAL_MS until FETCH_STOP_MS has elapsed since
// the cycle started. Positions still look live well past that: the
// backend keeps every aircraft's position dead-reckoned forward on its
// own independent schedule (see EstimatedPositionCache.java) regardless
// of whether this frontend is fetching at all — this cadence is purely
// about how often *this client* bothers asking, not about when data goes
// stale. At DIALOG_STOP_MS, this quietly asks the backend to reopen its
// hot-poll window again rather than assuming anyone's stopped watching —
// a plain 5-minute gap isn't itself a reason to interrupt someone with a
// dialog. Only once that renewal is actually rejected (this browser's own
// daily hot-poll allowance used up — see HotPollUserBudget below) does
// ResumeDialog appear; clicking its button retries the same way an
// explicit resume always has.
//
// Separately, on mount only, a one-off effect makes sure the backend's own
// hot-poll window (flighttracker.agents.poll-window-seconds, currently 5
// minutes — matched to DIALOG_STOP_MS/FETCH_STOP_MS, which is why all
// three are the same value here) is actually open — but only if it's
// currently closed. Someone loading the page while another tab already
// has it open takes no action, so a steady trickle of new visitors can't
// keep it pinned open forever; it's only ever (re)started by an actual
// page load with nothing already running, or an explicit "Resume
// tracking" click. Two backend caps sit behind all of this, both there to
// degrade to the always-on global sweep (every
// flighttracker.agents.global-sweep-interval-seconds) rather than run hot
// polling unbounded: how much of it this browser's own IP can claim in a
// day (hot-poll-seconds-per-ip-per-day — see HotPollUserBudget; past it,
// POST /api/agents/restart itself starts returning 429, same as the
// existing per-IP restart-request-rate limit) and how much hot polling
// happens globally across every caller (hot-poll-daily-call-budget — see
// PollWindowService; past it, restart still succeeds and the window shows
// as open, but the "agent" container quietly stops actually hot-polling
// until that budget resets).
const FETCH_INTERVAL_MS = 72_000;
const FETCH_STOP_MS = 5 * 60_000;
const DIALOG_STOP_MS = 5 * 60_000;

const ROUTE_COLOR = "#4db2ff"; // matches --color-accent in FlightMap.css

// How many interpolated points to insert between each pair of real
// reports — purely a rendering concern (see smoothRoute below), not
// stored or refetched, so this can be generous without any cost beyond
// one polyline's point count.
const ROUTE_SPLINE_SEGMENTS = 8;

/**
 * Catmull-Rom spline through `points`, passing exactly through every real
 * report (unlike a fitted/least-squares curve, which wouldn't) — this is
 * about rendering the straight-segment jaggedness between sparse ADS-B
 * reports as a smooth curve, not about filtering GPS noise out of the
 * data itself. Falls back to the original points untouched below 3 of
 * them, where a spline segment isn't well-defined anyway.
 */
function smoothRoute(points: [number, number][]): [number, number][] {
  if (points.length < 3) return points;
  const at = (i: number) => points[Math.max(0, Math.min(points.length - 1, i))];
  const result: [number, number][] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const [lat0, lon0] = at(i - 1);
    const [lat1, lon1] = at(i);
    const [lat2, lon2] = at(i + 1);
    const [lat3, lon3] = at(i + 2);
    for (let s = 0; s < ROUTE_SPLINE_SEGMENTS; s++) {
      const t = s / ROUTE_SPLINE_SEGMENTS;
      const t2 = t * t;
      const t3 = t2 * t;
      const lat =
        0.5 *
        (2 * lat1 + (-lat0 + lat2) * t + (2 * lat0 - 5 * lat1 + 4 * lat2 - lat3) * t2 + (-lat0 + 3 * lat1 - 3 * lat2 + lat3) * t3);
      const lon =
        0.5 *
        (2 * lon1 + (-lon0 + lon2) * t + (2 * lon0 - 5 * lon1 + 4 * lon2 - lon3) * t2 + (-lon0 + 3 * lon1 - 3 * lon2 + lon3) * t3);
      result.push([lat, lon]);
    }
  }
  result.push(points[points.length - 1]);
  return result;
}

// Cyberpunk theme's TileLayer points here instead of OpenStreetMap — a
// transparent 1x1 PNG as a data: URI, so Leaflet never makes a real
// network request for it (no fetch at all; the browser just decodes the
// inline data), and every tile renders fully invisible. A *real*
// TileLayer still has to be mounted even so: confirmed by bisection that
// swapping it out entirely (rendering only VectorBasemap, or a raw
// L.gridLayer() with no url) makes Leaflet throw inside a passive effect
// on mount — something in Leaflet/react-leaflet's own internals
// genuinely depends on a real TileLayer component existing, not just
// "some layer, any layer." This satisfies that without fetching or
// showing any real map imagery — VectorBasemap draws over it.
const BLANK_TILE_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

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
// Leaflet actually creates the DOM node, rather than baking a rotation
// value in at construction time. Reading rotation from a ref (mutated
// every render, not just on creation) here —
// rather than baking a rotation value into the icon at construction time —
// means whatever the aircraft's heading is *by the time Leaflet gets
// around to it* is what gets painted, instead of whatever it was when the
// React element was first created.
class RotatingPlaneIcon extends L.DivIcon {
  headingRef: { current: number };
  // Read here (via a safe DOM API, textContent) rather than interpolated
  // into planeIcon()'s html string the way heading's rotation angle is a
  // plain numeric transform — callsign is untrusted external OpenSky
  // data, and Leaflet sets that html string as raw innerHTML, so baking
  // arbitrary attacker-influenceable text straight into it would be an
  // XSS hole (see planeIcon's own aria-label comment for the same
  // reasoning). Unlike heading, callsign never changes after an
  // aircraft's marker is first created, so — unlike headingRef, which
  // AircraftMarker also re-applies on every position tick via a direct
  // effect — this only ever needs to run once, right here.
  callsignRef: { current: string };
  constructor(options: L.DivIconOptions, headingRef: { current: number }, callsignRef: { current: string }) {
    super(options);
    this.headingRef = headingRef;
    this.callsignRef = callsignRef;
  }
  createIcon(oldIcon?: HTMLElement) {
    const el = super.createIcon(oldIcon);
    const glyph = el.querySelector<HTMLElement>(".plane-glyph");
    if (glyph) glyph.style.transform = `rotate(${this.headingRef.current}deg)`;
    const label = el.querySelector<HTMLElement>(".plane-icon-label");
    if (label) label.textContent = this.callsignRef.current;
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
function planeIcon(
  known: boolean,
  selected: boolean,
  zoom: number,
  headingRef: { current: number },
  callsignRef: { current: string },
  entering: boolean,
  exiting: boolean,
) {
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
  const baseSize = selected
    ? (isMobile ? MOBILE_SELECTED_ICON_SIZE : SELECTED_ICON_SIZE)
    : (isMobile ? MOBILE_ICON_SIZE : ICON_SIZE);
  // Selected keeps a higher floor than scaleIconSize's own default — it's
  // the one aircraft actually being tracked, so it should stay readable
  // even zoomed all the way out, not shrink to the same speck every
  // other marker does.
  const size = selected ? Math.max(scaleIconSize(baseSize, zoom), 16) : scaleIconSize(baseSize, zoom);
  return new RotatingPlaneIcon(
    {
      // plane-icon--entering only on a genuinely new aircraft's first icon
      // — see AircraftMarker's enteringRef for why every *later* icon
      // rebuild for the same marker (a zoom-driven resize, a selection
      // toggle) must never carry this, even though Leaflet creates an
      // equally fresh DOM node for those too: replaying the entrance fade
      // on every zoom step read as a flicker, not as smoothness. This is
      // specifically the "aircraft ease onto the map instead of all
      // popping in the instant a pan/zoom fetch resolves" treatment.
      // plane-icon--exiting is the reverse case: zoom has crossed below
      // CLUSTER_FETCH_MAX_ZOOM and this marker is stale, unrefreshed data
      // fading out under the cluster bubbles taking its place (see
      // AircraftMarker's own comment on why positions is deliberately not
      // cleared the moment clustering kicks in).
      className: `plane-icon${selected ? " plane-icon--selected" : ""}${entering ? " plane-icon--entering" : ""}${exiting ? " plane-icon--exiting" : ""}`,
      // .plane-icon-mark/.plane-icon-label are cyberpunk-theme-only (see
      // FlightMap.css) — always present in the markup either way so
      // RotatingPlaneIcon.createIcon() has a consistent DOM shape to fill
      // in regardless of theme, at the cost of two harmless empty/hidden
      // elements on the default theme.
      html: `<div class="plane-icon-halo" aria-hidden="true"></div><div class="plane-icon-mark" aria-hidden="true"></div><div class="${glyphClass}" role="img" aria-label="Aircraft position marker">${PLANE_SVG}</div><div class="plane-icon-label" aria-hidden="true"></div>`,
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2],
    },
    headingRef,
    callsignRef,
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
 * Reports the current map viewport (and zoom, which feeds
 * scaleIconSize's marker-size scaling) up to the parent — once on mount,
 * and again every time panning/zooming settles (moveend only fires once
 * movement has actually stopped, so this is naturally debounced
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

// Below this, an individual-marker viewport can mean thousands of aircraft
// (global tracking, not just one region) — confirmed on a real deploy
// (~69k tracked worldwide) to freeze rendering entirely, not just feel
// slow, echoing exactly what MIN_ICON_SIZE_PX's own comment below warned
// this simpler approach risked. Below this zoom, the map switches to
// ClusterMarker (one bubble per populated grid cell, from the same backend
// aggregation endpoint — FlightController.liveClusters) instead of
// individual AircraftMarkers. Raised from an initial 5 to 7 — even a
// several-country view at 5-6 over dense real European traffic was still
// enough individual markers to visibly stutter; see MAX_INDIVIDUAL_MARKERS
// just below for the second, count-driven backstop this alone wasn't
// enough on its own (a fixed zoom can't know how busy any given view
// actually is).
const CLUSTER_FETCH_MAX_ZOOM = 8;

// Backstop for individual-marker mode (zoom >= CLUSTER_FETCH_MAX_ZOOM):
// even a "should be fine" zoom level can land on an unusually dense area
// (a busy hub, a major air corridor) with more real traffic than that
// static threshold assumed. Rather than trusting the zoom guess alone,
// unselectedList itself is checked at render time — over this count, it's
// bucketed into ClusterMarker bubbles client-side (clusterPositions below,
// same grid math as the server-side aggregation, just run against data
// already in hand) instead of one AircraftMarker per aircraft. No extra
// network round trip: positions was already fetched in full for this
// exact reason (selection, the WS reconcile, etc. all still need it) —
// this only changes how the *unselected* bulk is rendered, not what's
// fetched.
const MAX_INDIVIDUAL_MARKERS = 500;

// A cluster cell should read as roughly this many screen px across, so
// neighboring cells don't crowd into an unreadable smear — the backend
// clamps whatever degree value this converts to into its own
// [MIN_CLUSTER_GRID_DEG, MAX_CLUSTER_GRID_DEG] range regardless (see
// FlightController.liveClusters), so this only needs to be a reasonable
// target, not an exact figure. Raised from 64 per request to see fewer,
// bigger cells each covering more area/aircraft — easy to tune back down
// if it reads as too coarse.
const CLUSTER_TARGET_PX = 110;

// Web Mercator tile math (256px tiles, doubling every zoom level) —
// approximate (real px/degree varies with latitude; this is the equator
// figure), same as this app's other zoom-driven sizing (scaleIconSize
// below), which is likewise a deliberately simple approximation rather
// than a full per-marker reprojection.
function gridDegForZoom(zoom: number): number {
  const degPerPixel = 360 / (256 * Math.pow(2, zoom));
  return CLUSTER_TARGET_PX * degPerPixel;
}

// MAX_INDIVIDUAL_MARKERS' own client-side bucketing — mirrors
// FlightPositionRepository.findLiveClusteredInBounds's bucket-then-center
// math exactly (floor(coord/gridDeg)*gridDeg, offset to the cell's
// center), just run in JS against a list already in memory instead of a
// SQL GROUP BY, since the point here is avoiding a network round trip.
function clusterPositions(list: LiveMarker[], gridDeg: number): ClusterPoint[] {
  const buckets = new Map<string, ClusterPoint>();
  for (const p of list) {
    const bucketLat = Math.floor(p.latitude / gridDeg) * gridDeg;
    const bucketLon = Math.floor(p.longitude / gridDeg) * gridDeg;
    const key = `${bucketLat},${bucketLon}`;
    const existing = buckets.get(key);
    if (existing) existing.count++;
    else buckets.set(key, { lat: bucketLat + gridDeg / 2, lon: bucketLon + gridDeg / 2, count: 1 });
  }
  return Array.from(buckets.values());
}

// Aircraft icons shrink toward this floor as you zoom out (down to
// CLUSTER_FETCH_MAX_ZOOM, below which clustering takes over entirely —
// see above), rather than switching to a different representation
// immediately. A prior version of this app fetched server-aggregated
// counts below zoom 4 for the same reason CLUSTER_FETCH_MAX_ZOOM exists
// now, was simplified away to "draw real markers at every zoom, just
// smaller" once, and — per this comment's own prediction — that measured
// cost (rendering every individual aircraft worldwide blocking the main
// thread) resurfaced as global tracking's aircraft count grew, which is
// what brought clustering back.
const MIN_ICON_SIZE_PX = 9;
// Zoom at and above which icons render at their full, unscaled size —
// picked to match SELECTED_MIN_ZOOM, the zoom a selection's flyTo already
// treats as "close enough" to stop zooming further in.
const FULL_SIZE_ZOOM = SELECTED_MIN_ZOOM;

// Linear falloff from MIN_ICON_SIZE_PX at zoom 0 to `base` at
// FULL_SIZE_ZOOM and above — simple on purpose (no easing curve): the
// only requirement is "visibly smaller when zoomed out, never smaller
// than legible/tappable," not a particular curve shape.
function scaleIconSize(base: number, zoom: number): number {
  if (zoom >= FULL_SIZE_ZOOM) return base;
  const t = Math.max(0, zoom) / FULL_SIZE_ZOOM;
  return Math.round(MIN_ICON_SIZE_PX + (base - MIN_ICON_SIZE_PX) * t);
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

// The dossier's originAirportName/destinationAirportName are resolved
// live against the airport reference table now (see AircraftController.
// resolveAirport), so a name is present whenever the ICAO code is known
// at all — the icao/iata fallback below is for the rare code the
// reference table itself doesn't have, not the common case.
function formatAirport(name: string | null, icao: string | null, iata: string | null): string {
  const codes = [icao, iata].filter((c): c is string => Boolean(c)).join(" / ");
  if (name) return codes ? `${name} (${codes})` : name;
  return codes || "—";
}

function FollowSelected({
  selectedId,
  lat,
  lon,
  sheetExpanded,
  theme,
  focusRequest,
  onOffScreenChange,
}: {
  selectedId: string | null;
  lat: number | null;
  lon: number | null;
  // Only the default theme's flyTo below is safe to animate — see its own
  // comment for the cyberpunk-specific reason it still can't be.
  theme: Theme;
  // Mobile bottom-sheet collapsed/expanded state (see FlightMap.css's
  // ≤768px block) — irrelevant to desktop's layout, but on mobile the map
  // container's actual on-screen height changes when this toggles (the
  // sheet is a real flex sibling now, not an overlay — see .details-panel),
  // so this needs to be a dependency here too: without it, toggling the
  // sheet would leave the map still centered on wherever it was framed for
  // the *previous* map height, which is exactly the "plane hidden behind
  // the sheet" bug this replaces.
  sheetExpanded: boolean;
  // Bumped by the details panel's "Focus Plane" button (see FlightMap's
  // own state) — an increasing counter rather than a boolean so clicking
  // it twice in a row (still off-screen both times, nothing else about
  // the selection changed) is still a distinct, actionable change this
  // effect's dependency array will actually see.
  focusRequest: number;
  onOffScreenChange: (offScreen: boolean) => void;
}) {
  const map = useMap();
  // Distinguishes three reasons this effect can re-run: a genuinely new
  // selection, an explicit "Focus Plane" click, or the mobile sheet
  // resizing the visible map area — each gets centered — from an
  // ordinary position tick for an aircraft that's already been centered
  // once, which deliberately does *not* recenter (see the per-branch
  // comments below for why each of the first three still does).
  const lastCenteredIdRef = useRef<string | null>(null);
  const lastFocusRequestRef = useRef(focusRequest);
  const lastSheetExpandedRef = useRef(sheetExpanded);

  const checkOffScreen = useCallback(() => {
    onOffScreenChange(lat != null && lon != null && !map.getBounds().contains([lat, lon]));
  }, [map, lat, lon, onOffScreenChange]);

  // Independent of the centering effect below: the tracked aircraft can
  // drift off-screen (or back on) from either end — its own position
  // moving, or the user panning/zooming the map themselves — and the
  // "Focus Plane" button needs to reflect that live regardless of which
  // one just happened.
  useMapEvents({ moveend: checkOffScreen, zoomend: checkOffScreen });

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
      onOffScreenChange(false);
      return;
    }
    if (lat == null || lon == null) return;

    const isNewSelection = lastCenteredIdRef.current !== selectedId;
    const isFocusRequest = !isNewSelection && focusRequest !== lastFocusRequestRef.current;
    const isSheetToggle = !isNewSelection && !isFocusRequest && sheetExpanded !== lastSheetExpandedRef.current;
    lastCenteredIdRef.current = selectedId;
    lastFocusRequestRef.current = focusRequest;
    lastSheetExpandedRef.current = sheetExpanded;

    if (isNewSelection || isFocusRequest) {
      // A new selection zooms in; an explicit Focus click just brings an
      // already-selected, off-screen aircraft back into view at whatever
      // zoom the user already had — Math.max leaves that alone rather
      // than re-applying SELECTED_MIN_ZOOM's floor a second time.
      const targetZoom = Math.max(map.getZoom(), SELECTED_MIN_ZOOM);
      if (theme === "cyberpunk") {
        // Not flyTo here: VectorBasemap's whole canvas-buffer cache only
        // swaps buffers at zoomstart/zoomend (see its own header comment)
        // on the assumption zoom changes are instant, which is also why
        // this theme disables Leaflet's own _zoomAnimated. flyTo's
        // animation path runs independently of that flag though - it
        // drives a real multi-frame zoom+pan tween regardless - so during
        // its ~0.8s the buffer stayed exactly where zoomstart left it
        // (the *previous* zoom/position) while the visible map raced far
        // past it, reading as the basemap and its red country fill
        // briefly vanishing mid-flight. setView jumps straight to the
        // destination in one frame, which is exactly the single
        // zoomstart→zoomend transition the buffer swap was already built
        // to handle correctly. Fixing this properly needs the buffer
        // swap itself reworked to animate alongside a real flyTo (e.g.
        // swapping at zoomend instead of zoomstart, letting Leaflet's own
        // pane transform carry the *old* buffer through the tween) —
        // real scope, not a one-line change, so left alone here.
        map.setView([lat, lon], targetZoom, { animate: false });
      } else {
        // The default theme's plain raster TileLayer has none of the
        // above constraint — Leaflet's ordinary zoom animation already
        // handles a raster tile layer correctly mid-flight, tiles and
        // all, so a real flyTo is safe here.
        map.flyTo([lat, lon], targetZoom, { duration: 0.8 });
      }
    } else if (isSheetToggle) {
      // The visible map area itself just changed shape (mobile sheet
      // expanding/collapsing) — recenter so the selected aircraft doesn't
      // end up newly hidden behind it, but this isn't the user asking to
      // look elsewhere, so leave zoom alone and don't touch it below.
      map.panTo([lat, lon], { animate: true, duration: 0.5 });
    }
    // Deliberately no else branch: an ordinary position tick for an
    // aircraft that's already been centered once does *not* recenter the
    // map on every update. It used to (panTo here unconditionally) —
    // real user feedback was that panning away to look at other traffic
    // got yanked straight back the instant the tracked aircraft's
    // position ticked, which made "look at something else while still
    // tracking a flight" impossible. onOffScreenChange below is the
    // replacement: it surfaces a "Focus Plane" button (see FlightMap's
    // details panel) instead of forcing the view back.
    checkOffScreen();
  }, [selectedId, lat, lon, map, sheetExpanded, theme, focusRequest, onOffScreenChange, checkOffScreen]);
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
  zoom,
  onSelect,
  exiting = false,
}: {
  position: LiveMarker;
  selected: boolean;
  zoom: number;
  onSelect: (p: LiveMarker) => void;
  // True once the map has zoomed out past CLUSTER_FETCH_MAX_ZOOM — this
  // specific marker's data has gone stale (positions stops being fetched/
  // refreshed while clustered, see FlightMap's own comment on that) and
  // it's fading out under the cluster bubbles taking its place, rather
  // than being torn down immediately. Never true for the selected marker
  // (it isn't part of the clustered/unclustered switch — see where it's
  // rendered), so this only matters for the bulk unselected list.
  exiting?: boolean;
}) {
  const markerRef = useRef<L.Marker | null>(null);
  const known = position.headingDeg != null;
  const rotationDeg = known ? (position.headingDeg as number) : 0;

  // Kept current on every render (not just in an effect) so that whenever
  // RotatingPlaneIcon.createIcon() actually runs, it reads the most recent
  // heading rather than whatever was current when the icon was constructed.
  const headingRef = useRef(rotationDeg);
  headingRef.current = rotationDeg;

  // See RotatingPlaneIcon's own callsignRef comment: read once at icon-
  // creation time via a safe DOM API, not a per-tick-updated live value
  // the way heading is — a callsign doesn't change after an aircraft's
  // marker first exists, so unlike headingRef this has no companion
  // effect re-applying it to an already-mounted icon.
  const callsignRef = useRef(position.callsign?.trim() || position.icao24.toUpperCase());

  // Rounded before it's a dependency, not just before it's used, so a
  // fractional zoom change (shouldn't normally happen with the default
  // zoomSnap, but isn't guaranteed) doesn't recreate every marker's icon
  // — full DOM teardown/rebuild, per this component's own comments above
  // — over a change too small to visibly matter.
  const roundedZoom = Math.round(zoom);
  // True only the first time this marker's icon is built (this aircraft's
  // React element genuinely mounting for the first time) — every later
  // recompute this useMemo does (roundedZoom or selected changing) leaves
  // it false, flipped the instant it's read. See planeIcon's own comment
  // on why that distinction matters for plane-icon--entering.
  const enteringRef = useRef(true);
  const icon = useMemo(() => {
    const built = planeIcon(known, selected, roundedZoom, headingRef, callsignRef, enteringRef.current, exiting);
    enteringRef.current = false;
    return built;
  }, [known, selected, roundedZoom, exiting]);

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

const CLUSTER_ICON_MIN_PX = 22;
const CLUSTER_ICON_MAX_PX = 56;

// Square-root, not linear: a cell's on-screen *area* tracks its aircraft
// count, so a cell with 4x the traffic reads as roughly 2x the size, not
// 4x — keeps one very busy hub from swallowing the whole screen relative
// to its quieter neighbors.
function clusterIconSize(count: number): number {
  return Math.round(Math.min(CLUSTER_ICON_MAX_PX, CLUSTER_ICON_MIN_PX + 6 * Math.sqrt(count)));
}

// How many overlapping plane glyphs a cluster's mark shows — a coarse,
// 3-bucket read of "how much traffic," not the exact count (see
// clusterIcon's own comment for why the exact number was dropped
// entirely rather than kept as a badge). Thresholds are a judgment call,
// not derived from anything: picked so the three real bucket sizes seen
// in a live deploy (single digits, tens, and the busiest hubs' hundreds)
// each land in a visibly different bucket.
function clusterPlaneCount(count: number): 2 | 3 | 4 {
  if (count < 10) return 2;
  if (count < 50) return 3;
  return 4;
}

function clusterIcon(count: number, entering: boolean): L.DivIcon {
  const size = clusterIconSize(count);
  const planes = clusterPlaneCount(count);
  // Reuses plane-icon--entering (see planeIcon's own comment) rather than
  // a second parallel fade-in mechanism — the CSS keyframes/class don't
  // care what kind of marker they're attached to.
  //
  // Reads as "traffic," not "a statistic": 2/3/4 of the same plane glyph
  // AircraftMarker itself uses, all facing the same way (northeast) in a
  // flying-V formation — one leader, the rest trailing behind it in two
  // overlapping arms (see .cluster-icon-mark--N in FlightMap.css) —
  // rather than a bare number in a circle. No count anywhere on the mark
  // at all now — per feedback, the circle backing and the exact-count
  // badge both read as "a statistic," which was exactly what this was
  // trying to move away from.
  return new L.DivIcon({
    className: `cluster-icon${entering ? " plane-icon--entering" : ""}`,
    html: `<div class="cluster-icon-mark cluster-icon-mark--${planes}">${PLANE_SVG.repeat(planes)}</div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

// One aggregated cell from fetchLiveClusters, rendered below
// CLUSTER_FETCH_MAX_ZOOM instead of individual AircraftMarkers — see that
// constant's own comment for why. Clicking zooms in, the same "help me
// get to the traffic instead of hand-zooming" affordance VectorBasemap's
// airport-dot click already established.
const ClusterMarker = memo(function ClusterMarker({ cluster }: { cluster: ClusterPoint }) {
  const map = useMap();
  const enteringRef = useRef(true);
  const icon = useMemo(() => {
    const built = clusterIcon(cluster.count, enteringRef.current);
    enteringRef.current = false;
    return built;
  }, [cluster.count]);
  return (
    <Marker
      position={[cluster.lat, cluster.lon]}
      icon={icon}
      eventHandlers={{
        // A flat +3 rather than jumping straight past CLUSTER_FETCH_MAX_ZOOM:
        // a very dense cell may still cluster (just into smaller cells) after
        // one click, which is fine — another click keeps drilling in exactly
        // the way panning/re-fetching already works. animate: false matches
        // every other click-to-zoom in this app (FollowSelected, the airport
        // dot) — see FollowSelected's own comment for why cyberpunk theme
        // specifically needs that, kept unconditional here for consistency
        // with the default theme too.
        click: () => map.setView([cluster.lat, cluster.lon], map.getZoom() + 3, { animate: false }),
      }}
    />
  );
});

export default function FlightMap() {
  const [positions, setPositions] = useState<Record<string, LiveMarker>>({});
  // Below CLUSTER_FETCH_MAX_ZOOM only — see handleViewportChange/
  // fetchFreshData. `positions` itself is deliberately left as-is rather
  // than cleared the moment clustering kicks in: AircraftMarker fades its
  // stale entries out under these bubbles fading in (see exiting prop)
  // instead of a hard cut, and the next real individual-mode fetch (zooming
  // back in) replaces it wholesale anyway.
  const [clusters, setClusters] = useState<ClusterPoint[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  // Captured at click time and kept live-updated by the WebSocket feed and
  // the periodic reconcile below, but — unlike a plain positions[selected]
  // lookup — never nulled out just because the aircraft momentarily isn't
  // in the live set. A user looking at one aircraft's details is exactly
  // the wrong moment for it to vanish from under them (e.g. right as it
  // crosses into "landed" and briefly races the next reconcile).
  //
  // Typed SelectedPosition, not FlightPosition: the bulk fetch that
  // usually seeds this (a click, or applyLiveSnapshot's reconcile below)
  // only ever has a LiveMarker in hand, not the fuller row — see
  // LiveMarker's own javadoc/comment for why. altitudeM starts null and
  // reads as "—" until the dedicated priority poll or a WebSocket push
  // (both fetch/deliver a full FlightPosition) fills it in, same pattern
  // this file already uses for the dossier fields.
  const [selectedPos, setSelectedPos] = useState<SelectedPosition | null>(null);
  // Mobile-only bottom-sheet state (see the ≤768px block in FlightMap.css):
  // collapsed shows just the summary + an expand toggle; expanded also
  // shows the fields grid. Irrelevant above the breakpoint — the CSS driven
  // by this class only does anything inside that media query. Reset to
  // collapsed on every new selection (handleSelect below) so a previous
  // aircraft's expanded state doesn't carry over to the next one.
  const [dossierExpanded, setDossierExpanded] = useState(false);
  // Whether the selected aircraft's marker is currently outside the map's
  // visible bounds — see FollowSelected, which no longer auto-recenters
  // on every ordinary position tick. Drives the details panel's "Focus
  // Plane" button below; focusRequest is what that button bumps to ask
  // FollowSelected for a one-off recenter.
  const [planeOffScreen, setPlaneOffScreen] = useState(false);
  const [focusRequest, setFocusRequest] = useState(0);
  // Ticked every second while an aircraft is selected, purely to force the
  // details panel's "last updated" line to re-render as time passes —
  // selectedPos.observedAt itself doesn't change between real updates, so
  // without this the display would only advance when a new position
  // actually arrived, defeating the point of showing staleness at all.
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [route, setRoute] = useState<[number, number][]>([]);
  const [dossier, setDossier] = useState<AircraftDossier | null>(null);
  // The airport dossier's own selection — mutually exclusive with
  // selected/selectedPos above (picking one clears the other, see
  // handleSelect and handleAirportSelect) since only one details panel
  // can occupy the desktop side panel / mobile bottom sheet at a time.
  // Populated instantly from the click (code/name/lat/lon all come
  // straight off VectorBasemap's own WORLD_AIRPORTS entry, no fetch
  // needed), then airportInfo backfills the reference-table fields
  // (municipality/country/ICAO) moments later, same "—" until loaded
  // convention as dossier above.
  const [airportDossier, setAirportDossier] = useState<AirportSelection | null>(null);
  const [airportInfo, setAirportInfo] = useState<AirportInfo | null>(null);

  // Client-side only (see favorites.ts) — loaded once from localStorage on
  // mount via useState's lazy initializer, kept in React state from then on
  // so FavoritesPanel/the star toggles below re-render on every change,
  // and persisted back to localStorage inside the toggle handlers
  // themselves (toggleFavoriteRoute/toggleFavoriteAircraft do both).
  const [favoriteRoutes, setFavoriteRoutes] = useState<FavoriteRoute[]>(() => loadFavoriteRoutes());
  const [favoriteAircraft, setFavoriteAircraft] = useState<FavoriteAircraft[]>(() => loadFavoriteAircraft());

  // Decides which map layer mounts below (TileLayer vs. VectorBasemap),
  // not just CSS — index.html's own inline script already set the
  // data-theme DOM attribute before first paint if the stored preference
  // was "cyberpunk" (see theme.ts), so loadTheme() here just needs to
  // agree with what's already on screen, not re-apply it.
  const [theme, setTheme] = useState<Theme>(() => loadTheme());
  const toggleTheme = useCallback(() => {
    setTheme((prev) => {
      const next: Theme = prev === "cyberpunk" ? "default" : "cyberpunk";
      saveTheme(next);
      return next;
    });
  }, []);

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
  const selectedPosRef = useRef<SelectedPosition | null>(null);
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
  // every zoom step, and state so AircraftMarker's zoom-scaled icon size
  // (see scaleIconSize) re-renders when it actually changes.
  const zoomRef = useRef(6);
  const [zoom, setZoom] = useState(6);

  // Worldwide, independent of viewport/zoom — see fetchLiveCount. Refreshed
  // alongside every other fetchFreshData tick rather than on its own timer,
  // so the "TRACKED" chip doesn't drift out of sync with the rest of the
  // live-data refresh cadence.
  const [globalTrackedCount, setGlobalTrackedCount] = useState(0);

  // Gates BootScreen's dismissal (cyberpunk theme only) — true once the
  // first live-position fetch has resolved, success or failure alike
  // (see applyLiveSnapshot's .finally). A real signal, not a fixed fake
  // delay: the boot sequence should track how long the app's actual
  // first load takes, not perform a canned animation regardless of it.
  const [firstLoadDone, setFirstLoadDone] = useState(false);

  // Mirrors `positions` synchronously (state updates aren't readable
  // mid-render, but applyLiveSnapshot below needs the current value the
  // instant its fetch resolves, not a render cycle later) — see its use
  // there for why.
  const positionsRef = useRef<Record<string, LiveMarker>>({});

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
  function isNewer(a: { observedAt: string }, b: { observedAt: string }) {
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

  // Mirrors `route` synchronously, timestamped — `route` itself is just
  // [lat, lon] pairs (all Polyline needs), which isn't enough to re-trim
  // once legStartAtRef (below) becomes known after some points are already
  // in. Written to directly in appendRoutePoint rather than read back out
  // of setRoute's updater, for the same reason positionsRef mirrors
  // `positions` directly: a plain synchronous mutation here, instead of a
  // side effect tucked inside the updater callback, isn't at risk of
  // double-applying under React's dev-mode double-invoke.
  const routePointsRef = useRef<{ lat: number; lon: number; observedAt: string }[]>([]);

  // This leg's actual takeoff time (AircraftDossier.legStartAt), once the
  // dossier lookup resolves — null until then, or permanently null for an
  // aircraft with no airborne history for this leg at all. Reset alongside
  // `route` in the selection-change effect below. Read by both the history
  // fetch and the dossier fetch (whichever resolves second re-trims/
  // filters against it — see both below), since a plain fixed lookback
  // window on its own can't tell "this leg" apart from an earlier landing/
  // taxi/takeoff still inside that window.
  const legStartAtRef = useRef<string | null>(null);

  // Appends a point to the selected aircraft's trail. Shared between the
  // WebSocket push handler and applyLiveSnapshot's REST reconcile below —
  // both can hand this a fresher position for the selected aircraft, and
  // both need to keep the trail in sync with it.
  function appendRoutePoint(p: LiveMarker) {
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
    const last = routePointsRef.current[routePointsRef.current.length - 1];
    if (last && last.lat === p.latitude && last.lon === p.longitude) return;
    routePointsRef.current = [...routePointsRef.current, { lat: p.latitude, lon: p.longitude, observedAt: p.observedAt }];
    setRoute((prev) => [...prev, [p.latitude, p.longitude]]);
  }

  function applyLiveSnapshot(bounds: Bounds | null) {
    const seq = ++liveRequestSeqRef.current;
    return fetchLivePositions(bounds ?? undefined).then((list) => {
      if (seq !== liveRequestSeqRef.current) return; // superseded by a newer request
      const merged: Record<string, LiveMarker> = {};
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
        // Only ever a LiveMarker here (see above) — merge its fresher
        // position/heading fields onto whatever selectedPos already has
        // rather than replacing it outright, so a full detail fetch's
        // altitudeM survives this reconcile instead of being wiped back to
        // null on every pan/zoom.
        setSelectedPos((prev) => (prev ? { ...prev, ...current } : { ...current, altitudeM: null }));
        appendRoutePoint(current);
      }
    }).finally(() => setFirstLoadDone(true));
    // .finally, not chained onto success only: BootScreen (cyberpunk
    // theme only) waits on firstLoadDone to dismiss — a backend that's
    // down should still let someone past the boot screen into the
    // (empty/erroring) map, not strand them on "Initializing…" forever.
    // Harmless to set on every later poll too, not just the first;
    // firstLoadDone latches true and BootScreen stops watching it once
    // hidden.
  }

  // Below CLUSTER_FETCH_MAX_ZOOM, fetches aggregated clusters instead of
  // individual positions and leaves `positions` itself alone (see
  // `clusters` state's own comment on why) — otherwise the ordinary
  // individual-marker path, clearing any stale clusters left over from a
  // moment ago spent zoomed further out.
  function fetchForZoom(bounds: Bounds, zoom: number) {
    if (zoom < CLUSTER_FETCH_MAX_ZOOM) {
      // .finally, not chained onto success only — same reasoning as
      // applyLiveSnapshot's own .finally: BootScreen shouldn't be able to
      // wait forever just because a first load happens to land already
      // zoomed out past CLUSTER_FETCH_MAX_ZOOM (the current default
      // center/zoom never does, but nothing enforces that staying true).
      fetchLiveClusters(bounds, gridDegForZoom(zoom)).then(setClusters).catch(() => {}).finally(() => setFirstLoadDone(true));
      return;
    }
    setClusters([]);
    applyLiveSnapshot(bounds);
  }

  function fetchFreshData() {
    fetchLiveCount().then(setGlobalTrackedCount).catch(() => {});
    if (!boundsRef.current) return;
    fetchForZoom(boundsRef.current, zoomRef.current);
  }

  function handleViewportChange(bounds: Bounds, newZoom: number) {
    boundsRef.current = bounds;
    zoomRef.current = newZoom;
    setZoom(newZoom);
    fetchForZoom(bounds, newZoom);
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
    // The TRACKED chip's own fetch — viewport-independent, so it doesn't
    // belong on every ViewportReporter pan/zoom report the way
    // applyLiveSnapshot does. Without this, the chip would sit at its
    // initial 0 until fetchFreshData's own first tick (FETCH_INTERVAL_MS
    // after mount, since generation-0 fresh data comes from
    // ViewportReporter's mount report calling handleViewportChange, not
    // fetchFreshData — see the comment above the fetch-effect below).
    fetchLiveCount().then(setGlobalTrackedCount).catch(() => {});
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

  // Every DIALOG_STOP_MS since this cycle began, try to silently keep the
  // watch going rather than interrupting whoever's still looking at an
  // open tab — as long as this browser's IP hasn't used up its own daily
  // hot-poll allowance yet (HotPollUserBudget), there's no reason a plain
  // 5-minute idle gap should require a manual click. A successful silent
  // renewal resets the cycle exactly like startCycle() would (so the fetch
  // effect above keeps going, and this same effect reschedules itself via
  // the cycleGeneration bump) — the only difference from an explicit
  // "Resume tracking" click is that nobody had to make it. ResumeDialog
  // only appears once that renewal is actually rejected (429) — at that
  // point nothing this component can do automatically will help, so it's
  // finally worth surfacing to a human. A network error (as opposed to a
  // real 429) falls back to showing the dialog too, same as before this
  // silent-renewal behavior existed: better to ask than to assume it's
  // safe to keep retrying silently against a backend that isn't answering.
  useEffect(() => {
    let cancelled = false;
    const timeout = setTimeout(() => {
      restartPolling()
        .then((outcome) => {
          if (cancelled) return;
          if (outcome.rateLimited) {
            setShowResumeDialog(true);
          } else {
            cycleStartRef.current = Date.now();
            fetchFreshData();
            setCycleGeneration((g) => g + 1);
          }
        })
        .catch(() => {
          if (!cancelled) setShowResumeDialog(true);
        });
    }, DIALOG_STOP_MS - (Date.now() - cycleStartRef.current));
    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // Dedicated, viewport-independent priority refresh for whichever
  // aircraft is currently selected. Both other update paths can silently
  // stop covering it: applyLiveSnapshot's REST fetch is scoped to the
  // current map bounds (or, at cluster-summary zoom, doesn't fetch
  // individual aircraft at all), and the WebSocket feed is filtered
  // server-side by whatever viewport was last *reported* — see the
  // comment by the selected marker below. An aircraft someone has
  // deliberately selected is exactly the wrong one to let go stale just
  // because it (or the map) moved outside that scope, so this polls it
  // directly by icao24 instead, unconditionally for as long as it stays
  // selected — including past FETCH_STOP_MS, unlike the general fetch
  // cycle above, since bandwidth-saving shouldn't come at the cost of the
  // one aircraft someone is actively looking at.
  useEffect(() => {
    if (!selected) return;
    const icao24 = selected;
    let cancelled = false;
    function poll() {
      fetchFlightLive(icao24)
        .then((p) => {
          if (cancelled || !p || p.icao24 !== selectedRef.current) return;
          const existing = positionsRef.current[p.icao24];
          if (existing && !isNewer(p, existing)) return; // superseded by a fresher update already
          setPositions((prev) => {
            const next = { ...prev, [p.icao24]: p };
            positionsRef.current = next;
            return next;
          });
          setSelectedPos(p);
          appendRoutePoint(p);
        })
        .catch(() => {}); // best-effort — the WS feed and the general fetch cycle still cover the common case
    }
    poll();
    const interval = setInterval(poll, FETCH_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
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
    routePointsRef.current = [];
    legStartAtRef.current = null;
    if (!selected) {
      setDossier(null);
      setSelectedPos(null);
      return;
    }
    const to = new Date().toISOString();
    const from = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(); // last 6h of history
    fetchHistory(selected, from, to).then((track) => {
      if (cancelled) return; // superseded by a newer selection since this was requested
      // A trail is never longer than this leg's own origin airport — plain
      // history has no notion of "this leg" and would otherwise happily
      // include an earlier landing/taxi/takeoff still inside the 6h lookback
      // above. legStartAtRef is only set here if the dossier fetch below
      // already resolved first; if it resolves *after* this, that handler
      // re-filters routePointsRef/route the same way once it knows.
      const filtered = legStartAtRef.current
        ? track.filter((p) => p.observedAt >= legStartAtRef.current!)
        : track;
      if (filtered.length > 0) lastRouteObservedAtRef.current = filtered[filtered.length - 1].observedAt;
      routePointsRef.current = filtered.map((p) => ({ lat: p.latitude, lon: p.longitude, observedAt: p.observedAt }));
      setRoute(filtered.map((p) => [p.latitude, p.longitude]));
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
      .then((d) => {
        if (cancelled) return;
        setDossier(d);
        legStartAtRef.current = d?.legStartAt ?? null;
        // The history fetch above may already have landed first (with
        // nothing to trim against yet, since this is what sets it) — apply
        // the trim now if so.
        if (legStartAtRef.current) {
          const trimmed = routePointsRef.current.filter((pt) => pt.observedAt >= legStartAtRef.current!);
          if (trimmed.length !== routePointsRef.current.length) {
            routePointsRef.current = trimmed;
            setRoute(trimmed.map((pt) => [pt.lat, pt.lon]));
          }
        }
      })
      .catch(() => { if (!cancelled) setDossier(null); });

    return () => {
      cancelled = true;
    };
  }, [selected]);

  // Stable across renders (setSelected/setSelectedPos identities never
  // change) so it doesn't defeat AircraftMarker's memoization the way a
  // freshly-allocated closure passed as a prop would.
  const handleSelect = useCallback((p: LiveMarker) => {
    // Mutually exclusive with the airport dossier below.
    setAirportDossier(null);
    setSelected(p.icao24);
    // altitudeM starts null (see SelectedPosition's own comment) — the
    // dedicated priority poll below fires immediately once `selected`
    // changes and fills in the real value within one round trip, same as
    // this file's existing dossier-fields "—" until loaded convention.
    // Preserves a still-fresh selectedPos's altitudeM across a reselect of
    // the same aircraft (e.g. clicking it again) rather than nulling it
    // out for no reason.
    setSelectedPos((prev) => (prev && prev.icao24 === p.icao24 ? { ...prev, ...p } : { ...p, altitudeM: null }));
    setDossierExpanded(false);
  }, []);

  // Mirrors handleSelect above: clears any aircraft selection (mutually
  // exclusive panels) and resets the mobile bottom-sheet to collapsed.
  // airportInfo is fetched fresh on every click rather than cached by
  // code client-side — the reference-table lookup is cheap (a single
  // indexed read) and airports are clicked rarely enough next to
  // aircraft that a cache would save little.
  const handleAirportSelect = useCallback((ap: AirportSelection) => {
    setSelected(null);
    setAirportDossier(ap);
    setAirportInfo(null);
    setDossierExpanded(false);
    fetchAirportInfo(ap.code)
      .then(setAirportInfo)
      .catch(() => {});
  }, []);

  const toggleSelectedAircraftFavorite = useCallback(() => {
    if (!selectedPos) return;
    setFavoriteAircraft((prev) =>
      toggleFavoriteAircraft(prev, {
        icao24: selectedPos.icao24,
        registration: dossier?.registration ?? null,
        callsign: selectedPos.callsign,
      }),
    );
  }, [selectedPos, dossier]);

  const toggleSelectedRouteFavorite = useCallback(() => {
    if (!dossier?.originAirport || !dossier?.destinationAirport) return;
    setFavoriteRoutes((prev) =>
      toggleFavoriteRoute(prev, {
        origin: dossier.originAirport!,
        originName: dossier.originAirportName,
        originIata: dossier.originAirportIata,
        destination: dossier.destinationAirport!,
        destinationName: dossier.destinationAirportName,
        destinationIata: dossier.destinationAirportIata,
      }),
    );
  }, [dossier]);

  // Both callers already have the full favorite object in hand (FavoritesPanel
  // is just rendering back what it was given), so removal is exactly the
  // add path's toggle, re-run on something already present — one code path
  // for both directions, via the functional setState form so this needs no
  // dependency on the current list at all.
  const removeFavoriteAircraft = useCallback((entry: FavoriteAircraft) => {
    setFavoriteAircraft((prev) => toggleFavoriteAircraft(prev, entry));
  }, []);

  const removeFavoriteRoute = useCallback((route: FavoriteRoute) => {
    setFavoriteRoutes((prev) => toggleFavoriteRoute(prev, route));
  }, []);

  const list = Object.values(positions);
  // Rendered separately from the selected aircraft, see below — its
  // marker is always drawn last (on top) rather than in this list.
  const unselectedList = selected ? list.filter((p) => p.icao24 !== selected) : list;

  // MAX_INDIVIDUAL_MARKERS' own backstop: an individual-marker zoom that
  // still turned out too busy to draw one AircraftMarker per aircraft
  // falls back to the same client-side bucketing clusterPositions does,
  // rather than trusting CLUSTER_FETCH_MAX_ZOOM's static guess alone.
  const clientClustered = zoom >= CLUSTER_FETCH_MAX_ZOOM && unselectedList.length > MAX_INDIVIDUAL_MARKERS;
  const clientClusters = useMemo(
    () => (clientClustered ? clusterPositions(unselectedList, gridDegForZoom(zoom)) : []),
    [clientClustered, unselectedList, zoom],
  );

  // Cyberpunk theme's "TRACKED" status chip — the worldwide total (see
  // fetchLiveCount/globalTrackedCount above), not list.length, which only
  // ever covers the current viewport and used to make this chip read as
  // "tracked in this section" rather than globally.
  const trackedCount = globalTrackedCount;

  // Rendering-only: `route` itself stays the raw report points (favoriting
  // etc. has nothing to do with the curve), recomputed only when the
  // underlying points actually change rather than on every render.
  const smoothedRoute = useMemo(() => smoothRoute(route), [route]);

  const selectedAircraftFavorited = selectedPos ? isAircraftFavorited(favoriteAircraft, selectedPos.icao24) : false;
  const selectedRouteFavorited =
    dossier?.originAirport && dossier?.destinationAirport
      ? isRouteFavorited(favoriteRoutes, dossier.originAirport, dossier.destinationAirport)
      : false;

  return (
    <div className="app-shell">
      {theme === "cyberpunk" && <BootScreen ready={firstLoadDone} />}
      {/* Hidden once something's selected: the details panel (desktop
          side panel or mobile bottom sheet, see .details-panel) is a
          real flex sibling on mobile rather than an overlay, sized by
          collapsed/expanded state — a bottom-anchored dock has no fixed
          offset that wouldn't either overlap it or leave a gap across
          both states, so simplest correct rule is the dock is for
          browsing before a selection, not while the details panel
          already owns that part of the screen. */}
      {!selectedPos && !airportDossier && <Dock />}
      <div className="left-overlay-stack">
        {/* Same element, same JSX position, both themes — only its CSS
            position differs (see [data-theme="cyberpunk"] .app-header):
            default theme keeps it position:absolute, floating top-center
            same as always; cyberpunk theme drops that override so it
            flows as the first card in this column instead, matching the
            earlier approved mockup's own brand-chip placement. */}
        <header className="app-header">
          <h1>Netwatch Skygrid</h1>
          <p className="app-header-subtitle">Live aircraft positions</p>
        </header>
        <FlightSearch onSelect={handleSelect} />
        <FavoritesPanel
          routes={favoriteRoutes}
          aircraft={favoriteAircraft}
          onRemoveRoute={removeFavoriteRoute}
          onRemoveAircraft={removeFavoriteAircraft}
          onSelect={handleSelect}
        />
        {/* Cyberpunk-only: explains marks (airport squares, the
            home-country amber outline) that only exist on VectorBasemap
            — the default theme's plain OpenStreetMap tiles don't draw
            airports at all, so there'd be nothing for a legend to key. */}
        {theme === "cyberpunk" && <Legend />}
        <ThemeToggle theme={theme} onToggle={toggleTheme} />
      </div>
      {theme === "cyberpunk" && (
        <div className="tracked-chip">
          <span className="tracked-chip-dot" aria-hidden="true" />
          <span className="tracked-chip-label">Tracked</span>
          <span className="tracked-chip-value">{trackedCount.toLocaleString()}</span>
        </div>
      )}

      {showResumeDialog && (
        <div className="resume-dialog-backdrop" role="presentation">
          <div className="resume-dialog" role="dialog" aria-modal="true" aria-labelledby="resume-dialog-heading">
            <h2 id="resume-dialog-heading">Fast updates paused</h2>
            <p>
              This browser has used up its allowance of fast (18-second)
              live updates for today. The map keeps refreshing every few
              minutes in the meantime — fast updates come back once the
              allowance resets.
            </p>
            <button className="resume-dialog-button" onClick={startCycle}>Try again</button>
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
        //
        // maxBounds/maxBoundsViscosity close the other side of the same
        // hole: minZoom alone stops the *tile grid* from repeating, but a
        // wide-aspect viewport (or just panning hard east/west) could
        // still drag the visible area into a second, tile-only copy of
        // the world with no aircraft in it — real positions only ever
        // exist in the one canonical [-180,180] range, so a repeated copy
        // reads as "the planes disappeared." maxBoundsViscosity: 1 makes
        // this a hard stop (matches VectorBasemap's own single-world
        // canvas, which was never able to wrap at all) rather than
        // letting you drag past and spring back, which would still
        // flash the empty repeated copy for a frame.
        maxBounds={[[-90, -180], [90, 180]]}
        maxBoundsViscosity={1.0}
        className="map-container"
        zoomControl={false}
        aria-label="Live aircraft map"
        // Leaflet's default (60) reads as ~3 zoom levels per physical
        // scroll-wheel tick on at least one real mouse/trackpad — a jump
        // that size defeats VectorBasemap's cyberpunk-theme zoom cache
        // (it only pre-renders the immediate neighboring level), forcing
        // a full synchronous repaint on every tick instead of an instant
        // cached swap, on top of just feeling like too much per tick on
        // the default theme too. Raised so one tick tracks ~1 level.
        wheelPxPerZoomLevel={200}
      >
        {/* A real, always-mounted TileLayer, not a conditional one — see
            BLANK_TILE_URL's own comment for why cyberpunk theme still
            needs one even though VectorBasemap replaces what it shows. */}
        <TileLayer
          attribution={theme === "cyberpunk" ? "" : '&copy; OpenStreetMap contributors'}
          url={theme === "cyberpunk" ? BLANK_TILE_URL : "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"}
          // Belt-and-suspenders with maxBounds above: without this, a fast
          // drag can still briefly request/paint a second copy's tiles
          // before Leaflet's bounds correction catches up on drag end.
          noWrap
        />
        {theme === "cyberpunk" && (
          <Suspense fallback={null}>
            <VectorBasemap onAirportSelect={handleAirportSelect} />
          </Suspense>
        )}
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
          theme={theme}
          focusRequest={focusRequest}
          onOffScreenChange={setPlaneOffScreen}
        />

        {route.length > 1 && (
          <Polyline positions={smoothedRoute} className="route-line" pathOptions={{ color: ROUTE_COLOR, weight: 3, dashArray: "6 8" }} />
        )}

        {/* Below CLUSTER_FETCH_MAX_ZOOM: aggregated bubbles from the
            backend, not individual markers — see that constant's own
            comment. The individual list keeps rendering underneath (see
            AircraftMarker's exiting prop) so its markers can fade out
            under these fading in, rather than vanishing the instant
            clustering kicks in. */}
        {zoom < CLUSTER_FETCH_MAX_ZOOM &&
          clusters.map((c) => <ClusterMarker key={`${c.lat},${c.lon}`} cluster={c} />)}

        {/* MAX_INDIVIDUAL_MARKERS' own backstop, client-bucketed from data
            already in hand — no crossfade here (unlike the server-cluster
            case above): this exists specifically to avoid the render cost
            of a too-busy individual view, so the individual list is
            skipped outright below rather than kept mounted-but-fading. */}
        {clientClustered &&
          clientClusters.map((c) => <ClusterMarker key={`${c.lat},${c.lon}`} cluster={c} />)}

        {!clientClustered &&
          unselectedList.map((p) => (
            <AircraftMarker key={p.icao24} position={p} selected={false} zoom={zoom} onSelect={handleSelect} exiting={zoom < CLUSTER_FETCH_MAX_ZOOM} />
          ))}

        {/* Rendered last (on top) and separately from the list above, so
            the selected aircraft's marker never ends up underneath a
            neighbor's regardless of render order. */}
        {selectedPos && <AircraftMarker position={selectedPos} selected zoom={zoom} onSelect={handleSelect} />}
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
            {/* Only shown once the tracked aircraft has actually drifted
                off-screen (see FollowSelected/planeOffScreen) — panning
                away to look at other traffic no longer snaps the view
                back on its own (real feedback: that made "keep tracking
                this flight while looking around" impossible), so this is
                the deliberate, on-demand replacement for that. */}
            {planeOffScreen && (
              <button
                type="button"
                className="details-panel-focus-toggle"
                onClick={() => setFocusRequest((n) => n + 1)}
              >
                ⌖ Focus Plane
              </button>
            )}
            <div className="details-panel-favorite-toggles">
              <button
                type="button"
                className={`details-panel-favorite-toggle${selectedAircraftFavorited ? " details-panel-favorite-toggle--active" : ""}`}
                onClick={toggleSelectedAircraftFavorite}
                aria-pressed={selectedAircraftFavorited}
                aria-label="Favorite this aircraft"
              >
                {selectedAircraftFavorited ? "★" : "☆"} Track Aircraft
              </button>
              <button
                type="button"
                className={`details-panel-favorite-toggle${selectedRouteFavorited ? " details-panel-favorite-toggle--active" : ""}`}
                onClick={toggleSelectedRouteFavorite}
                disabled={!dossier?.originAirport || !dossier?.destinationAirport}
                aria-pressed={selectedRouteFavorited}
                aria-label="Favorite this route"
                title={!dossier?.originAirport || !dossier?.destinationAirport ? "Route not known for this aircraft yet" : undefined}
              >
                {selectedRouteFavorited ? "★" : "☆"} Track Route
              </button>
            </div>
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
              <dt>Origin</dt>
              <dd>{formatAirport(dossier?.originAirportName ?? null, dossier?.originAirport ?? null, dossier?.originAirportIata ?? null)}</dd>
              <dt>Destination</dt>
              <dd>{formatAirport(dossier?.destinationAirportName ?? null, dossier?.destinationAirport ?? null, dossier?.destinationAirportIata ?? null)}</dd>
              <dt>Phase</dt><dd>{formatFlightPhase(dossier?.flightPhase ?? null)}</dd>
              <dt>Altitude</dt>
              {/* Clamped at 0, not shown raw: barometric altitude reads a
                  few meters negative on the ground fairly often — sensor
                  noise around the standard-atmosphere reference, not a
                  real below-sea-level position — and "-23 m" for a parked
                  aircraft reads as a bug, not as a precision artifact. */}
              <dd>{selectedPos.altitudeM != null ? `${Math.round(Math.max(0, selectedPos.altitudeM))} m` : "—"}</dd>
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

      {/* The airport counterpart to the aircraft panel above — same
          .details-panel shell (desktop side panel / mobile bottom sheet),
          shown instead of it rather than alongside it (see handleSelect/
          handleAirportSelect, which keep the two selections mutually
          exclusive). No favorite toggles here: favoriting an airport
          itself was never asked for, only routes/aircraft. */}
      {airportDossier && (
        <aside
          className={`details-panel${dossierExpanded ? " details-panel--expanded" : ""}`}
          aria-labelledby="airport-details-panel-heading"
        >
          <button className="details-panel-close-x" onClick={() => setAirportDossier(null)} aria-label="Close airport details">
            ✕
          </button>
          <div className="details-panel-inner">
            <span className="details-panel-eyebrow" id="airport-details-panel-heading">Airport Details</span>
            <h2>{airportDossier.name || airportDossier.code}</h2>
            <p className="details-panel-meta">
              {airportInfo?.iataCode || airportDossier.code}
              {airportInfo?.icaoCode ? ` / ${airportInfo.icaoCode}` : ""}
            </p>
            <dl className="details-panel-fields">
              <dt>Municipality</dt><dd>{airportInfo?.municipality || "—"}</dd>
              <dt>Country</dt><dd>{airportInfo?.country || "—"}</dd>
              <dt>Latitude</dt><dd>{airportDossier.lat.toFixed(4)}°</dd>
              <dt>Longitude</dt><dd>{airportDossier.lon.toFixed(4)}°</dd>
            </dl>
            <button
              className="details-panel-expand-toggle"
              onClick={() => setDossierExpanded((v) => !v)}
              aria-expanded={dossierExpanded}
              aria-label={dossierExpanded ? "Show less" : "Show more"}
            >
              {dossierExpanded ? "▲" : "▼"}
            </button>
            <button className="details-panel-close" onClick={() => setAirportDossier(null)} aria-label="Close airport details">
              Close
            </button>
          </div>
        </aside>
      )}
    </div>
  );
}
