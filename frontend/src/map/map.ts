import L from "leaflet";
// Leaflet's own base stylesheet — defines `.leaflet-marker-icon`,
// `.leaflet-pane`, `.leaflet-tile-pane` etc. as `position: absolute`
// ("required styles" per Leaflet's own comment on this block). Without it
// every marker/pane falls back to normal document flow instead of being
// pinned via Leaflet's transform/negative-margin positioning.
import "leaflet/dist/leaflet.css";
import type { Bounds } from "../types/flight";
import { minZoomFor, WORLD_BOUNDS } from "./zoomLimits";
import { createWheelStepper } from "./wheelZoom";

// The TileLayer points here instead of a real tile server — a
// transparent 1x1 PNG as a data: URI, so Leaflet never makes a real network
// request for it, and every tile renders fully invisible. A *real*
// TileLayer still has to be mounted even so: Leaflet's own internals
// genuinely depend on a real TileLayer existing, not just "some layer, any
// layer" (confirmed by bisection in the previous UI framework's version).
// This satisfies that without fetching or showing any real map imagery —
// the MapLibre layer renders over it.
const BLANK_TILE_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

// Zoom a selection's flyTo treats as "close enough" to stop zooming
// further in — also markers.ts's FULL_SIZE_ZOOM, kept in sync by hand
// (no shared constant module for a single shared number).
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

export function boundsFromMap(map: L.Map): Bounds {
  const b = map.getBounds();
  const lonMin = b.getWest();
  const lonMax = b.getEast();
  // At extreme zoom-out (or after panning across wrapped "copies" of the
  // world), Leaflet's bounds can span or exceed a full 360° of longitude —
  // that's not a real bbox, it's "the whole world is visible". Send the
  // actual valid range in that case rather than nonsensical numbers.
  const spansWholeWorld = lonMax - lonMin >= 360;
  return {
    latMin: Math.max(-90, b.getSouth()),
    latMax: Math.min(90, b.getNorth()),
    lonMin: spansWholeWorld ? -180 : lonMin,
    lonMax: spansWholeWorld ? 180 : lonMax,
  };
}

export interface MapController {
  map: L.Map;
  destroy(): void;
}

/**
 * Creates the Leaflet map, the always-mounted TileLayer, and the lazy
 * MapLibre basemap layer (dynamically imported so it stays its own chunk — see map/maplibreBasemap.ts). Viewport reporting
 * (mount + every `moveend`) is wired here since it's a property of the map
 * itself, not any one UI module.
 */
export function createMap(
  container: HTMLElement,
  onViewportChange: (bounds: Bounds, zoom: number) => void,
  // false while a MapLibre basemap is still loading its first view, true
  // once it's drawn — the boot screen waits
  // on it. See whenBasemapReady in maplibreBasemap.ts.
  onBasemapReady: (ready: boolean) => void = () => {},
): MapController {
  // Must be on the element *before* L.map() runs: .map-container is what
  // gives it height:100%, and Leaflet measures (and caches) the container
  // size during construction. Added afterwards, the map believed it was
  // N×0 px until the next window resize, so every bbox it reported had
  // latMin === latMax.
  container.classList.add("map-container");
  const map = L.map(container, {
    center: [DEFAULT_VIEW.lat, DEFAULT_VIEW.lon],
    zoom: DEFAULT_VIEW.zoom,
    // Past this, the world starts wrapping into multiple side-by-side
    // copies — keeps the view to a single, unambiguous world (see
    // boundsFromMap's own comment on the same hole from the other side).
    // minZoom starts at the floor and is raised to fit the screen as soon as
    // it is measured (see fitMinZoom).
    minZoom: 2,
    maxBounds: WORLD_BOUNDS,
    maxBoundsViscosity: 1.0,
    zoomControl: false,
    // Wheel and touchpad zoom is stepped by our own handler below (see
    // map/wheelZoom.ts): Leaflet's turns every burst of wheel events into a
    // zoom level, so a spinning wheel or a touchpad swipe queued many.
    scrollWheelZoom: false,
  });
  const wheelStepper = createWheelStepper();
  const onWheel = (e: WheelEvent): void => {
    e.preventDefault(); // never the page's own scroll or the browser's pinch-zoom
    const step = wheelStepper.feed({ deltaY: e.deltaY, deltaMode: e.deltaMode, ctrlKey: e.ctrlKey, now: performance.now() });
    if (step !== 0) map.setZoomAround(map.mouseEventToContainerPoint(e), map.getZoom() + step);
  };
  container.addEventListener("wheel", onWheel, { passive: false });
  // Drops the "Leaflet" prefix (and flag) on phones, where the attribution
  // strip otherwise takes two lines; the data credits stay.
  if (window.matchMedia("(max-width: 768px)").matches) map.attributionControl.setPrefix(false);

  const containerEl = map.getContainer();
  containerEl.setAttribute("aria-label", "Live aircraft map");
  // Test-only hook (see tests/helpers.ts __findLeafletMap): with React gone
  // there's no fiber tree to walk to find the mounted map instance, so it's
  // stashed directly on its own container element instead — the smallest
  // surface that still keeps this out of any real application code path.
  (containerEl as unknown as { _leaflet_map: L.Map })._leaflet_map = map;

  const tileLayer = L.tileLayer(BLANK_TILE_URL, {
    attribution: "",
    // Belt-and-suspenders with maxBounds above: without this, a fast drag
    // can still briefly request/paint a second copy's tiles before
    // Leaflet's bounds correction catches up on drag end.
    noWrap: true,
  }).addTo(map);

  let maplibreLayer: L.Layer | null = null;
  let destroyed = false;
  // Loaded while the boot screen still covers the map, the only time it's
  // safe to warm neighbouring zoom levels (that briefly moves MapLibre's camera).
  onBasemapReady(false);
  import("./maplibreBasemap")
    .then(({ createMaplibreLayer, whenBasemapReady, isSmallScreen }) => {
      if (destroyed) return;
      const layer = createMaplibreLayer();
      maplibreLayer = layer;
      layer.addTo(map);
      // Warming the neighbouring zoom levels is two more rounds of tile
      // loading and rendering; worth it on a desktop, not on a phone.
      return whenBasemapReady(layer, !isSmallScreen());
    })
    .catch(() => {})
    .finally(() => onBasemapReady(true));

  // Reports on every `moveend`. The *initial* report (equivalent to the
  // original ViewportReporter's own mount-time call) is deliberately not
  // fired here — main.ts triggers it explicitly once every layer that a
  // report can cascade into (markers, clusters) has been created, avoiding
  // an initialization-order hazard where the very first viewport report
  // could otherwise fire before those exist.
  function report(): void {
    onViewportChange(boundsFromMap(map), map.getZoom());
  }
  map.on("moveend", report);

  // A screen wider (or taller) than one world would show the world repeating
  // beside itself, so zooming out stops where one world just fills the screen.
  function fitMinZoom(): void {
    const { x, y } = map.getSize();
    if (x === 0 || y === 0) return; // not laid out yet; the next remeasure fixes it
    const min = minZoomFor(x, y);
    if (min !== map.getMinZoom()) map.setMinZoom(min);
  }
  map.whenReady(fitMinZoom);

  // Leaflet caches the container's size and only re-reads it on a window
  // resize. On a phone the container's size also changes with no window
  // resize: the dynamic toolbars (dvh), the flex layout settling once other
  // parts of the shell mount, a page restored from the back/forward cache.
  // A stale size means tiles (and the GL basemap) cover only part of the
  // screen. Re-measure on any change to the container or the visual viewport;
  // invalidateSize is a no-op when nothing changed.
  const remeasure = (): void => {
    map.invalidateSize({ debounceMoveend: true });
    fitMinZoom();
  };
  const resizeObserver = typeof ResizeObserver !== "undefined" ? new ResizeObserver(remeasure) : null;
  resizeObserver?.observe(container);
  window.visualViewport?.addEventListener("resize", remeasure);
  window.addEventListener("pageshow", remeasure);

  function destroy(): void {
    container.removeEventListener("wheel", onWheel);
    map.off("moveend", report);
    resizeObserver?.disconnect();
    window.visualViewport?.removeEventListener("resize", remeasure);
    window.removeEventListener("pageshow", remeasure);
    destroyed = true;
    maplibreLayer?.remove();
    map.remove();
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
export function createFollowSelected(map: L.Map, onOffScreenChange: (offScreen: boolean) => void): FollowSelectedHandle {
  let lastCenteredId: string | null = null;
  let lastFocusRequest = 0;
  let lastSheetExpanded = false;
  let currentLat: number | null = null;
  let currentLon: number | null = null;

  function checkOffScreen(): void {
    onOffScreenChange(currentLat != null && currentLon != null && !map.getBounds().contains([currentLat, currentLon]));
  }
  map.on("moveend", checkOffScreen);
  map.on("zoomend", checkOffScreen);

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
    // Leaflet caches the container's last-known size and won't repaint
    // tiles/markers to fit a new one on its own — needed both when the
    // mobile sheet just mounted/changed height and when it just unmounted.
    // A no-op when the size genuinely hasn't changed, so unconditional here
    // is fine.
    map.invalidateSize();

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
      map.flyTo([lat, lon], targetZoom, { duration: 0.8 });
    } else if (isSheetToggle) {
      map.panTo([lat, lon], { animate: true, duration: 0.5 });
    }
    // Deliberately no else branch: an ordinary position tick does not
    // recenter the map.
    checkOffScreen();
  }

  function destroy(): void {
    map.off("moveend", checkOffScreen);
    map.off("zoomend", checkOffScreen);
  }

  return { update, destroy };
}
