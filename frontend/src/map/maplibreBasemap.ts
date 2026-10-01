import L from "leaflet";
import { setWorkerUrl, type Map as MaplibreMap } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
// Vite bundles this as a worker entry (its own imports pulled in with it)
// and hands back the emitted, hashed URL. See setWorkerUrl below for why
// that has to be done by hand.
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import "@maplibre/maplibre-gl-leaflet";
import { CYBERPUNK_STYLE } from "../cyberpunkMapStyle";

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

/**
 * The cyberpunk theme's basemap — a MapLibre GL layer rendering
 * cyberpunkMapStyle.ts over OpenFreeMap's vector tiles. Dynamically
 * imported (see map.ts's `mountMaplibre`) so maplibre-gl (~260KB gzipped,
 * only ever needed by the cyberpunk theme) isolates into its own async
 * chunk instead of bloating the bundle every default-theme user pays for.
 *
 * Adding it via maplibre-gl-leaflet puts it on the same Leaflet map
 * instance every marker/polyline/control already lives on — nothing else
 * has to know it exists.
 */
// Buffers that keep zooming and panning from looking like a redraw:
//  - padding: the GL canvas is this fraction of the viewport larger on every
//    side, so a pan reveals map that's already rendered (plugin default 0.1).
//  - maxTileCacheZoomLevels: how many zoom levels of tiles stay cached
//    (MapLibre default 5), so zooming back out or in redraws from memory.
//  - fadeDuration 0: labels appear at once instead of fading in again after
//    every zoom step, which read as the whole map re-rendering.
//  - refreshExpiredTiles false: tiles already loaded aren't re-fetched just
//    because their cache headers expired mid-session.
const BUFFER_OPTIONS = {
  padding: 0.25,
  maxTileCacheZoomLevels: 8,
  fadeDuration: 0,
  refreshExpiredTiles: false,
};

// Upper bound on holding the boot screen for the basemap: a slow or
// unreachable tile server must never trap anyone behind it.
const BASEMAP_READY_CAP_MS = 5_000;

export function createMaplibreLayer(): L.Layer {
  return (
    L as unknown as {
      maplibreGL: (opts: Record<string, unknown>) => L.Layer;
    }
  ).maplibreGL({
    ...BUFFER_OPTIONS,
    style: CYBERPUNK_STYLE,
    attribution:
      '&copy; <a href="https://openfreemap.org">OpenFreeMap</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  });
}

/**
 * Resolves once the basemap has finished rendering the current view (or
 * BASEMAP_READY_CAP_MS has passed). With `warmNeighbourZooms` — only while
 * the boot screen is still covering the map — it then renders one zoom
 * level out and one in behind the scenes and returns to the starting view,
 * so the first zoom either way draws from cached tiles instead of loading
 * them on screen. Moves only MapLibre's own camera; Leaflet, the markers
 * and the data fetches never see it.
 */
export async function whenBasemapReady(layer: L.Layer, warmNeighbourZooms: boolean): Promise<void> {
  const gl = (layer as unknown as { getMaplibreMap(): MaplibreMap | null }).getMaplibreMap();
  if (!gl) return;
  const deadline = Date.now() + BASEMAP_READY_CAP_MS;
  const rendered = (): Promise<void> =>
    new Promise((resolve) => {
      if (gl.loaded() && gl.areTilesLoaded()) return resolve();
      const left = deadline - Date.now();
      if (left <= 0) return resolve();
      const timer = setTimeout(resolve, left);
      gl.once("idle", () => {
        clearTimeout(timer);
        resolve();
      });
    });

  await rendered();
  if (!warmNeighbourZooms) return;
  const center = gl.getCenter();
  const zoom = gl.getZoom();
  for (const dz of [-1, 1]) {
    if (Date.now() >= deadline) break;
    gl.jumpTo({ center, zoom: zoom + dz });
    await rendered();
  }
  gl.jumpTo({ center, zoom });
  await rendered();
}
