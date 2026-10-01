import L from "leaflet";
// Leaflet's own base stylesheet — defines `.leaflet-marker-icon`,
// `.leaflet-pane`, `.leaflet-tile-pane` etc. as `position: absolute`
// ("required styles" per Leaflet's own comment on this block). Without it
// every marker/pane falls back to normal document flow instead of being
// pinned via Leaflet's transform/negative-margin positioning.
import "leaflet/dist/leaflet.css";
import type { Bounds } from "../types/flight";
import type { Theme } from "../theme";

// Cyberpunk theme's TileLayer points here instead of OpenStreetMap — a
// transparent 1x1 PNG as a data: URI, so Leaflet never makes a real network
// request for it, and every tile renders fully invisible. A *real*
// TileLayer still has to be mounted even so: Leaflet's own internals
// genuinely depend on a real TileLayer existing, not just "some layer, any
// layer" (confirmed by bisection in the previous UI framework's version).
// This satisfies that without fetching or showing any real map imagery —
// the MapLibre layer renders over it.
const BLANK_TILE_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const OSM_TILE_URL = "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";
const OSM_ATTRIBUTION = "&copy; OpenStreetMap contributors";

// Zoom a selection's flyTo treats as "close enough" to stop zooming
// further in — also markers.ts's FULL_SIZE_ZOOM, kept in sync by hand
// (no shared constant module for a single shared number).
export const SELECTED_MIN_ZOOM = 10;

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
  setTheme(theme: Theme): void;
  destroy(): void;
}

/**
 * Creates the Leaflet map, the always-mounted TileLayer, and the lazy
 * MapLibre basemap layer (cyberpunk theme only, dynamically imported so it
 * stays its own chunk — see map/maplibreBasemap.ts). Viewport reporting
 * (mount + every `moveend`) is wired here since it's a property of the map
 * itself, not any one UI module.
 */
export function createMap(
  container: HTMLElement,
  theme: Theme,
  onViewportChange: (bounds: Bounds, zoom: number) => void,
  // false while a MapLibre basemap is still loading its first view, true
  // once it's drawn (or the plain theme needs none) — the boot screen waits
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
    center: [59.33, 18.06],
    zoom: 6,
    // Past this, the world starts wrapping into multiple side-by-side
    // copies — keeps the view to a single, unambiguous world (see
    // boundsFromMap's own comment on the same hole from the other side).
    minZoom: 2,
    maxBounds: [
      [-90, -180],
      [90, 180],
    ],
    maxBoundsViscosity: 1.0,
    zoomControl: false,
    // Leaflet's default (60) reads as ~3 zoom levels per physical
    // scroll-wheel tick on at least one real mouse/trackpad. Raised so one
    // tick tracks ~1 level.
    wheelPxPerZoomLevel: 200,
  });

  const containerEl = map.getContainer();
  containerEl.setAttribute("aria-label", "Live aircraft map");
  // Test-only hook (see tests/helpers.ts __findLeafletMap): with React gone
  // there's no fiber tree to walk to find the mounted map instance, so it's
  // stashed directly on its own container element instead — the smallest
  // surface that still keeps this out of any real application code path.
  (containerEl as unknown as { _leaflet_map: L.Map })._leaflet_map = map;

  const tileLayer = L.tileLayer(theme === "cyberpunk" ? BLANK_TILE_URL : OSM_TILE_URL, {
    attribution: theme === "cyberpunk" ? "" : OSM_ATTRIBUTION,
    // Belt-and-suspenders with maxBounds above: without this, a fast drag
    // can still briefly request/paint a second copy's tiles before
    // Leaflet's bounds correction catches up on drag end.
    noWrap: true,
  }).addTo(map);

  let maplibreLayer: L.Layer | null = null;
  let maplibreLoading: Promise<void> | null = null;
  let wantsMaplibre = false;

  // `atBoot`: the first mount, while the boot screen still covers the map —
  // the only time it's safe to warm neighbouring zoom levels, since that
  // briefly moves MapLibre's camera.
  function mountMaplibre(atBoot: boolean): void {
    wantsMaplibre = true;
    if (maplibreLayer || maplibreLoading) return;
    onBasemapReady(false);
    maplibreLoading = import("./maplibreBasemap")
      .then(({ createMaplibreLayer, whenBasemapReady }) => {
        maplibreLoading = null;
        // setTheme may have flipped back to default while the chunk was
        // loading — guard against mounting a layer nobody wants anymore.
        if (!wantsMaplibre) return;
        const layer = createMaplibreLayer();
        maplibreLayer = layer;
        layer.addTo(map);
        return whenBasemapReady(layer, atBoot);
      })
      .catch(() => {})
      .finally(() => onBasemapReady(true));
  }
  function unmountMaplibre(): void {
    wantsMaplibre = false;
    onBasemapReady(true);
    if (maplibreLayer) {
      maplibreLayer.remove();
      maplibreLayer = null;
    }
  }

  function setTheme(nextTheme: Theme): void {
    tileLayer.setUrl(nextTheme === "cyberpunk" ? BLANK_TILE_URL : OSM_TILE_URL);
    tileLayer.options.attribution = nextTheme === "cyberpunk" ? "" : OSM_ATTRIBUTION;
    if (nextTheme === "cyberpunk") mountMaplibre(false);
    else unmountMaplibre();
  }
  if (theme === "cyberpunk") mountMaplibre(true);
  else onBasemapReady(true);

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

  function destroy(): void {
    map.off("moveend", report);
    unmountMaplibre();
    map.remove();
  }

  return { map, setTheme, destroy };
}

export interface FollowSelectedUpdate {
  selectedId: string | null;
  /** icao24 the lat/lon below belong to — can briefly differ from selectedId mid-switch. */
  positionId: string | null;
  /** lat/lon came from the server after this selection was made (see AppState.selectedPosFresh). */
  positionFresh: boolean;
  lat: number | null;
  lon: number | null;
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

  function update({ selectedId, positionId, positionFresh, lat, lon, sheetExpanded, focusRequest }: FollowSelectedUpdate): void {
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
      const targetZoom = Math.max(map.getZoom(), SELECTED_MIN_ZOOM);
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
