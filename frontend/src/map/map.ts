import { LngLat, Map as MaplibreMap, MercatorCoordinate, type MapEventType } from "maplibre-gl";
import type { Bounds } from "../types/flight";
import { basemapOptions, whenBasemapReady } from "./maplibreBasemap";
import { minZoomFor, WORLD_BOUNDS } from "./zoomLimits";

// Zoom a selection's flyTo treats as "close enough" to stop zooming
// further in.
export const SELECTED_MIN_ZOOM = 10;

// Where the map starts when nothing better is known (see map/initialView.ts,
// which moves it to where the traffic is once the first data arrives).
export const DEFAULT_VIEW = { lat: 59.33, lon: 18.06, zoom: 6 };

// A selected aircraft that is on the ground and moving slower than this
// (taxiing, parked, pushing back — not a landing roll) gets a much closer
// zoom, so it is visible against the airport layout.
export const GROUND_MAX_SPEED_MS = 15;
export const GROUND_SELECTED_ZOOM = 16;

export function isTaxiing(onGround: boolean | null | undefined, velocityMs: number | null | undefined): boolean {
  return onGround === true && (velocityMs == null || velocityMs < GROUND_MAX_SPEED_MS);
}

/**
 * App zoom units. Everything outside this file (the backend's zoom/gridDeg,
 * CLUSTER_FETCH_MAX_ZOOM, icon sizes, zoomLimits.ts, the view caches, the
 * tests) speaks the zoom of 256 px tiles, which is what the map used before
 * MapLibre. MapLibre's tiles are 512 px, so the same view is one level lower
 * there. FlightMap converts at its edge; nothing else touches the GL map's zoom.
 */
const ZOOM_OFFSET = 1;
const toGl = (zoom: number): number => zoom - ZOOM_OFFSET;
const fromGl = (zoom: number): number => zoom + ZOOM_OFFSET;
const TILE_PX = 256;

/** The app's furthest zoom-in (the old raster layer's maxZoom). */
export const MAX_ZOOM = 18;
/** The app's furthest zoom-out on any screen; raised to fit the screen (see fitMinZoom). */
const MIN_ZOOM_FLOOR = 2;

// One 100 px mouse-wheel notch zooms about half a level: MapLibre's
// 2 / (1 + e^(-100 * rate)) scale per notch is sqrt(2) at this rate. Its
// default (1/450) is about 0.15 of a level, which made a wheel feel dead.
// The touchpad rate (small, frequent deltas) stays MapLibre's.
const WHEEL_ZOOM_RATE = 1 / 113.5;

export interface Point {
  x: number;
  y: number;
}

export interface LatLon {
  lat: number;
  lon: number;
}

export type MapEvent = keyof MapEventType;

/** Something clickable drawn in the map's own layers (a plane, an airport) under a pointer. */
export interface MapHit {
  /** Lower wins outright (the selected plane is 0); within a priority the nearest wins. */
  priority: number;
  /** From the pointer to the target's anchor, px. */
  distance: number;
  activate(): void;
}

/** A plane the plane layers drew (map/planes.ts), for tests. Pixels are container pixels. */
export interface RenderedPlane {
  icao24: string;
  callsign: string;
  lat: number;
  lon: number;
  x: number;
  y: number;
  /** Side of its icon box as drawn at the current zoom, px. */
  size: number;
  selected: boolean;
  dimmed: boolean;
  /** The callsign chip shown next to it (the selected plane only), else null. */
  label: string | null;
  /** It faded in when it arrived (a small batch), rather than just appearing. */
  fadedIn: boolean;
  /** performance.now() when it was last added to the drawn set: unchanged while it stays drawn. */
  drawnSince: number;
}

/** An airport the airport layer drew (ui/defaultAirports.ts), for tests. */
export interface RenderedAirport {
  code: string;
  lat: number;
  lon: number;
  x: number;
  y: number;
}

/**
 * The one MapLibre map, in app units: zoom as above, positions as
 * [lat, lon] / {lat, lon}, pixels relative to the map container. Tests reach
 * it as `._flightMap` on the container (see tests/helpers.ts).
 */
export class FlightMap {
  readonly gl: MaplibreMap;
  private styleReady = false;
  private styleQueue: (() => void)[] = [];
  private hitTargets: ((p: Point) => MapHit | null)[] = [];

  /** Test hook (tests/helpers.ts renderedPlanes): every plane drawn in view. Set by map/planes.ts. */
  renderedPlanes: () => RenderedPlane[] = () => [];
  /** Test hook: every airport drawn in view. Set by ui/defaultAirports.ts. */
  renderedAirports: () => RenderedAirport[] = () => [];

  constructor(gl: MaplibreMap) {
    this.gl = gl;
    gl.once("style.load", () => {
      this.styleReady = true;
      for (const fn of this.styleQueue.splice(0)) fn();
    });
    // Planes and airports are drawn by the map itself, so clicks and hovers
    // are hit-tested here (MapLibre fires no click after a drag).
    gl.on("click", (e) => this.hitAt(e.point)?.activate());
    let hoverFrame = 0;
    let hoverAt: Point = { x: 0, y: 0 };
    gl.on("mousemove", (e) => {
      hoverAt = e.point;
      if (hoverFrame) return;
      hoverFrame = requestAnimationFrame(() => {
        hoverFrame = 0;
        gl.getCanvas().style.cursor = this.hitAt(hoverAt) ? "pointer" : "";
      });
    });
  }

  /** Registers a hit test for something the map draws (see MapHit). */
  addHitTarget(fn: (p: Point) => MapHit | null): void {
    this.hitTargets.push(fn);
  }

  /** What a click at this container pixel would select, if anything. */
  hitAt(p: Point): MapHit | null {
    let best: MapHit | null = null;
    for (const target of this.hitTargets) {
      const hit = target(p);
      if (hit && (!best || hit.priority < best.priority || (hit.priority === best.priority && hit.distance < best.distance))) best = hit;
    }
    return best;
  }

  /** Runs `fn` once the style can take sources and layers (at once if it already can). */
  whenStyleReady(fn: () => void): void {
    if (this.styleReady) fn();
    else this.styleQueue.push(fn);
  }

  getContainer(): HTMLElement {
    return this.gl.getContainer();
  }

  getZoom(): number {
    return fromGl(this.gl.getZoom());
  }

  getMinZoom(): number {
    return fromGl(this.gl.getMinZoom());
  }

  setMinZoom(zoom: number): void {
    this.gl.setMinZoom(toGl(zoom));
  }

  getMaxZoom(): number {
    return fromGl(this.gl.getMaxZoom());
  }

  getCenter(): LatLon {
    const c = this.gl.getCenter();
    return { lat: c.lat, lon: c.lng };
  }

  /** The size the map last measured its container at, px. */
  getSize(): Point {
    const canvas = this.gl.getCanvas();
    return { x: canvas.clientWidth, y: canvas.clientHeight };
  }

  getBounds(): Bounds {
    const b = this.gl.getBounds();
    return {
      latMin: Math.max(-90, b.getSouth()),
      latMax: Math.min(90, b.getNorth()),
      lonMin: Math.max(-180, b.getWest()),
      lonMax: Math.min(180, b.getEast()),
    };
  }

  contains(lat: number, lon: number): boolean {
    const b = this.getBounds();
    return lat >= b.latMin && lat <= b.latMax && lon >= b.lonMin && lon <= b.lonMax;
  }

  /** Container pixel of a position. */
  project(lat: number, lon: number): Point {
    const p = this.gl.project([lon, lat]);
    return { x: p.x, y: p.y };
  }

  unproject(x: number, y: number): LatLon {
    const ll = this.gl.unproject([x, y]);
    return { lat: ll.lat, lon: ll.lng };
  }

  /** The bounds this view (same centre and size) would have at another zoom. */
  boundsAt(zoom: number): Bounds {
    const c = this.gl.getCenter();
    const size = this.getSize();
    const mid = MercatorCoordinate.fromLngLat(c);
    const world = TILE_PX * Math.pow(2, zoom);
    const dx = size.x / 2 / world;
    const dy = size.y / 2 / world;
    const sw = new MercatorCoordinate(mid.x - dx, mid.y + dy).toLngLat();
    const ne = new MercatorCoordinate(mid.x + dx, mid.y - dy).toLngLat();
    return { latMin: Math.max(-90, sw.lat), latMax: Math.min(90, ne.lat), lonMin: Math.max(-180, sw.lng), lonMax: Math.min(180, ne.lng) };
  }

  /** Ground distance one container pixel covers at the centre, metres. */
  metersPerPixel(samplePx = 200): number {
    const { x, y } = this.getSize();
    const a = this.gl.unproject([x / 2, y / 2]);
    const b = this.gl.unproject([x / 2 + samplePx, y / 2]);
    return new LngLat(a.lng, a.lat).distanceTo(b) / samplePx;
  }

  /** Moves the view. Instant unless `animate` (a short ease). */
  setView([lat, lon]: [number, number], zoom: number, opts: { animate?: boolean } = {}): void {
    const camera = { center: [lon, lat] as [number, number], zoom: toGl(zoom) };
    if (opts.animate) this.gl.easeTo({ ...camera, duration: 250 });
    else this.gl.jumpTo(camera);
  }

  /** Zooms about the centre. Animated unless `animate: false`, like a button zoom. */
  setZoom(zoom: number, opts: { animate?: boolean } = {}): void {
    if (opts.animate === false) this.gl.jumpTo({ zoom: toGl(zoom) });
    else this.gl.easeTo({ zoom: toGl(zoom), duration: 250 });
  }

  flyTo([lat, lon]: [number, number], zoom: number, durationMs: number): void {
    this.gl.flyTo({ center: [lon, lat], zoom: toGl(zoom), duration: durationMs });
  }

  panTo([lat, lon]: [number, number], durationMs: number): void {
    this.gl.panTo([lon, lat], { duration: durationMs });
  }

  isMoving(): boolean {
    return this.gl.isMoving();
  }

  /** Re-reads the container's size, if it changed since the map last measured it. */
  resize(): void {
    const el = this.getContainer();
    const size = this.getSize();
    if (el.clientWidth !== size.x || el.clientHeight !== size.y) this.gl.resize();
  }

  on(type: MapEvent, fn: () => void): void {
    this.gl.on(type, fn);
  }

  off(type: MapEvent, fn: () => void): void {
    this.gl.off(type, fn);
  }
}

export function boundsFromMap(map: FlightMap): Bounds {
  return map.getBounds();
}

export interface MapController {
  map: FlightMap;
  destroy(): void;
}

/**
 * Creates the map: one MapLibre map rendering the cyberpunk basemap, with
 * wheel, touchpad and pinch zoom handled by MapLibre itself (continuous,
 * fractional zoom; see WHEEL_ZOOM_RATE). Viewport reporting (every
 * `moveend`, which MapLibre fires once per gesture) is wired here since it's
 * a property of the map itself, not any one UI module.
 */
export function createMap(
  container: HTMLElement,
  onViewportChange: (bounds: Bounds, zoom: number) => void,
  // false while the basemap is still loading its first view, true once it's
  // drawn (or the cap ran out) — the boot screen waits on it. See
  // whenBasemapReady in maplibreBasemap.ts.
  onBasemapReady: (ready: boolean) => void = () => {},
): MapController {
  // Must be on the element *before* the map is constructed: .map-container
  // is what gives it height:100%, and MapLibre sizes its canvas from the
  // container during construction.
  container.classList.add("map-container");
  const [[south, west], [north, east]] = WORLD_BOUNDS;
  const gl = new MaplibreMap({
    ...basemapOptions(),
    container,
    center: [DEFAULT_VIEW.lon, DEFAULT_VIEW.lat],
    zoom: toGl(DEFAULT_VIEW.zoom),
    // minZoom starts at the floor and is raised to fit the screen as soon as
    // it is measured (see fitMinZoom).
    minZoom: toGl(MIN_ZOOM_FLOOR),
    maxZoom: toGl(MAX_ZOOM),
    // One world, never repeated beside itself, and panning stops at its edge.
    // The longitudes are pulled in a hair: at exactly ±180 MapLibre wraps the
    // east edge onto the west one, reads the world as 0 px wide and zooms to
    // infinity (its own default range without maxBounds does the same).
    renderWorldCopies: false,
    maxBounds: [
      [west + 1e-9, south],
      [east - 1e-9, north],
    ],
    // North up, always: no rotation or tilt from any gesture.
    dragRotate: false,
    pitchWithRotate: false,
    touchPitch: false,
  });
  gl.touchZoomRotate.disableRotation();
  gl.keyboard.disableRotation();
  gl.scrollZoom.setWheelZoomRate(WHEEL_ZOOM_RATE);

  const map = new FlightMap(gl);
  container.setAttribute("aria-label", "Live aircraft map");
  // Test-only hook (see tests/helpers.ts withMap): the adapter, stashed on its
  // own container element — the smallest surface that still keeps this out
  // of any real application code path.
  (container as unknown as { _flightMap: FlightMap })._flightMap = map;

  let destroyed = false;
  onBasemapReady(false);
  whenBasemapReady(gl)
    .catch(() => {})
    .finally(() => {
      if (!destroyed) onBasemapReady(true);
    });

  // Reports on every `moveend`. The *initial* report (equivalent to the
  // original ViewportReporter's own mount-time call) is deliberately not
  // fired here — main.ts triggers it explicitly once every layer that a
  // report can cascade into (markers, route) has been created, avoiding
  // an initialization-order hazard where the very first viewport report
  // could otherwise fire before those exist.
  function report(): void {
    onViewportChange(map.getBounds(), map.getZoom());
  }
  gl.on("moveend", report);

  // A screen wider (or taller) than one world would show the world repeating
  // beside itself, so zooming out stops where one world just fills the screen.
  function fitMinZoom(): void {
    const { x, y } = map.getSize();
    if (x === 0 || y === 0) return; // not laid out yet; the next remeasure fixes it
    const min = minZoomFor(x, y);
    if (min !== map.getMinZoom()) map.setMinZoom(min);
  }
  fitMinZoom();
  gl.on("resize", fitMinZoom);

  // MapLibre watches its container with a ResizeObserver of its own. A phone
  // also changes what is visible with no layout change to watch (the visual
  // viewport, a page restored from the back/forward cache), so re-measure on
  // those too; resize() is a no-op when nothing changed.
  const remeasure = (): void => map.resize();
  window.visualViewport?.addEventListener("resize", remeasure);
  window.addEventListener("pageshow", remeasure);

  function destroy(): void {
    destroyed = true;
    gl.off("moveend", report);
    gl.off("resize", fitMinZoom);
    window.visualViewport?.removeEventListener("resize", remeasure);
    window.removeEventListener("pageshow", remeasure);
    gl.remove();
  }

  return { map, destroy };
}

export interface FollowSelectedUpdate {
  selectedId: string | null;
  /** icao24 the lat/lon below belong to — can briefly differ from selectedId mid-switch. */
  positionId: string | null;
  /** lat/lon came from the server after this selection was made (see AppState.selectedPosFresh). */
  positionFresh: boolean;
  lat: number | null;
  lon: number | null;
  /** From the full position (absent on a marker-only selection that hasn't been refreshed yet). */
  onGround?: boolean | null;
  velocityMs?: number | null;
  /** Mobile bottom-sheet collapsed/expanded state — irrelevant on desktop. */
  sheetExpanded: boolean;
  /** Bumped by the details panel's "Focus Plane" button. */
  focusRequest: number;
}

export interface FollowSelectedHandle {
  update(params: FollowSelectedUpdate): void;
  destroy(): void;
}

/**
 * Keeps the map framed on the selected aircraft — flyTo on a genuinely new
 * selection or an explicit Focus-Plane click, panTo (no zoom change) when
 * the mobile sheet's own height just changed, and deliberately nothing on
 * an ordinary position tick (panning away to look at other traffic no
 * longer gets yanked back — see onOffScreenChange, the "Focus Plane"
 * button's own data source, for the replacement).
 */
export function createFollowSelected(map: FlightMap, onOffScreenChange: (offScreen: boolean) => void): FollowSelectedHandle {
  let lastCenteredId: string | null = null;
  let lastFocusRequest = 0;
  let lastSheetExpanded = false;
  let currentLat: number | null = null;
  let currentLon: number | null = null;

  function checkOffScreen(): void {
    onOffScreenChange(currentLat != null && currentLon != null && !map.contains(currentLat, currentLon));
  }
  map.on("moveend", checkOffScreen);

  function update({ selectedId, positionId, positionFresh, lat, lon, onGround, velocityMs, sheetExpanded, focusRequest }: FollowSelectedUpdate): void {
    // Switching from aircraft A to B updates selectedId and selectedPos one
    // after the other, so for a moment selectedId is B while lat/lon are
    // still A's. Treating that as "B's position" flew the map to A and
    // marked B as already centred, so B's real position was then ignored.
    if (selectedId != null && positionId !== selectedId) {
      lat = null;
      lon = null;
    }
    currentLat = lat;
    currentLon = lon;
    // The mobile sheet just mounted, changed height or unmounted: the map
    // has to know its new size *now*, before centring within it, not when
    // its own ResizeObserver gets round to it. A no-op when the size hasn't
    // changed, so unconditional here is fine.
    map.resize();

    if (selectedId == null) {
      lastCenteredId = null;
      onOffScreenChange(false);
      return;
    }
    if (lat == null || lon == null) return;
    // A new selection waits for a fresh position before flying: the one it
    // was selected with may be a list entry from many seconds ago.
    if (lastCenteredId !== selectedId && !positionFresh) return;

    const isNewSelection = lastCenteredId !== selectedId;
    const isFocusRequest = !isNewSelection && focusRequest !== lastFocusRequest;
    const isSheetToggle = !isNewSelection && !isFocusRequest && sheetExpanded !== lastSheetExpanded;
    lastCenteredId = selectedId;
    lastFocusRequest = focusRequest;
    lastSheetExpanded = sheetExpanded;

    if (isNewSelection || isFocusRequest) {
      const minZoom = isTaxiing(onGround, velocityMs) ? GROUND_SELECTED_ZOOM : SELECTED_MIN_ZOOM;
      const targetZoom = Math.max(map.getZoom(), minZoom);
      map.flyTo([lat, lon], targetZoom, 800);
    } else if (isSheetToggle) {
      map.panTo([lat, lon], 500);
    }
    // Deliberately no else branch: an ordinary position tick does not
    // recenter the map.
    checkOffScreen();
  }

  function destroy(): void {
    map.off("moveend", checkOffScreen);
  }

  return { update, destroy };
}
