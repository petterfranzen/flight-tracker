import { setWorkerUrl, type Map as MaplibreMap, type MapOptions } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
// Vite bundles this as a worker entry (its own imports pulled in with it)
// and hands back the emitted, hashed URL. See setWorkerUrl below for why
// that has to be done by hand.
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import { CYBERPUNK_STYLE } from "../cyberpunkMapStyle";
import { isSmallScreen } from "./screen";

// maplibre-gl works out its own worker URL at *runtime*, from import.meta.url:
//
//   let e = import.meta.url;
//   let t = e.endsWith("-dev.mjs") ? "maplibre-gl-worker-dev.mjs" : "maplibre-gl-worker.mjs";
//   return new URL(`./${t}`, e).href;
//
// The filename is a computed template string, so a bundler can't statically
// see it and Rollup never emits the worker into the build at all. At runtime
// import.meta.url is this chunk's own URL, so maplibre asks for
// /assets/maplibre-gl-worker.mjs — which doesn't exist.
//
// That failure is completely silent, which is what makes it worth this
// comment. A SPA host answers any unknown path with index.html and a 200
// (nginx `try_files $uri /index.html`; `vite preview` does the same), so the
// Worker constructor succeeds, receives HTML, fails to parse it as a module,
// and dies with no console error and no failed request. MapLibre keeps
// running on the main thread — it even fetches the style and its TileJSON
// successfully — but nothing ever parses a tile, so the map renders its
// background colour and nothing else. It looks exactly like "the tile server
// is unreachable", and it shipped to production once already looking like
// that.
//
// Pointing setWorkerUrl at an asset Vite really emitted fixes it. Note this
// is a *build* problem, distinct from the dev-server one that
// optimizeDeps.exclude in vite.config.ts handles — the two have the same
// symptom and different causes, so changing one doesn't tell you anything
// about the other.
setWorkerUrl(maplibreWorkerUrl);

export { isSmallScreen };

const ATTRIBUTION =
  '&copy; <a href="https://openfreemap.org">OpenFreeMap</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const MAPLIBRE_CREDIT = '<a href="https://maplibre.org/">MapLibre</a>';

/**
 * The basemap's own MapLibre options: cyberpunkMapStyle.ts over OpenFreeMap's
 * vector tiles. Camera, interaction and zoom-unit options belong to map.ts.
 *  - maxTileCacheZoomLevels: how many zoom levels of tiles stay cached
 *    (MapLibre default 5), so zooming back out or in redraws from memory.
 *  - fadeDuration 0: labels appear at once instead of fading in again after
 *    every zoom, which read as the whole map re-rendering.
 *  - refreshExpiredTiles false: tiles already loaded aren't re-fetched just
 *    because their cache headers expired mid-session.
 *  - pixelRatio: the canvas is rendered at the device pixel ratio by default;
 *    a 3x phone shades 2.25x the pixels of a 2x one for detail the eye can't
 *    tell on a map. Desktop and 2x displays are unchanged.
 */
export function basemapOptions(): Partial<MapOptions> {
  return {
    style: CYBERPUNK_STYLE,
    maxTileCacheZoomLevels: 8,
    fadeDuration: 0,
    refreshExpiredTiles: false,
    pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
    // Expanded, not MapLibre's collapsible "i" button. Phones drop the
    // library credit (the data credits stay), which otherwise wraps the
    // strip onto a second line.
    attributionControl: { compact: false, customAttribution: isSmallScreen() ? ATTRIBUTION : `${MAPLIBRE_CREDIT} | ${ATTRIBUTION}` },
  };
}

// Upper bound on holding the boot screen for the basemap: a slow or
// unreachable tile server must never trap anyone behind it.
const BASEMAP_READY_CAP_MS = 5_000;
const BASEMAP_READY_CAP_SMALL_MS = 3_000;

/**
 * Resolves once the basemap has finished rendering its first view (the map's
 * first `idle`), or after BASEMAP_READY_CAP_MS, whichever comes first.
 */
export function whenBasemapReady(gl: MaplibreMap): Promise<void> {
  return new Promise((resolve) => {
    if (gl.loaded() && gl.areTilesLoaded()) return resolve();
    const done = (): void => {
      clearTimeout(timer);
      gl.off("idle", done);
      resolve();
    };
    const timer = setTimeout(done, isSmallScreen() ? BASEMAP_READY_CAP_SMALL_MS : BASEMAP_READY_CAP_MS);
    gl.on("idle", done);
  });
}
