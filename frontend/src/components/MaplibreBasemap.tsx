import { useEffect } from "react";
import { useMap } from "react-leaflet";
import L from "leaflet";
import { setWorkerUrl } from "maplibre-gl";
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
 * cyberpunkMapStyle.ts over OpenFreeMap's vector tiles, replacing the
 * hand-drawn canvas renderer this used to be (see that file's header for
 * why, and git history for the ~1100 lines it retires).
 *
 * The reason this is a short component rather than a rewrite of the map:
 * the maplibre-gl-leaflet bridge adds MapLibre as an ordinary *Leaflet
 * layer*, on the same map instance every existing marker, polyline,
 * cluster and control already lives on. Nothing else in FlightMap.tsx has
 * to know it exists.
 *
 * Most of what the canvas renderer did has no counterpart here on purpose,
 * because MapLibre owns it natively: the per-zoom-level buffer cache, the
 * pan-refresh throttle, the background pre-render of neighbouring zooms,
 * and the greedy label-collision queue were all reimplementations of
 * tiling, caching and symbol placement.
 */
export default function MaplibreBasemap() {
  const map = useMap();

  useEffect(() => {
    // maplibre-gl-leaflet defaults its layer into Leaflet's tilePane
    // (z-index 200), the same place the raster TileLayer sits on the other
    // theme — so markerPane (600) and DefaultAirports' own airport-overlay
    // pane (650) keep stacking above it exactly as they always have.
    const layer = (L as unknown as {
      maplibreGL: (opts: { style: unknown; attribution?: string }) => L.Layer;
    }).maplibreGL({
      style: CYBERPUNK_STYLE,
      attribution:
        '&copy; <a href="https://openfreemap.org">OpenFreeMap</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    });

    layer.addTo(map);
    return () => {
      layer.remove();
    };
  }, [map]);

  return null;
}
