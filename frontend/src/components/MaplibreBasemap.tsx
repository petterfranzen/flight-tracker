import { useEffect } from "react";
import { useMap } from "react-leaflet";
import L from "leaflet";
import "maplibre-gl/dist/maplibre-gl.css";
import "@maplibre/maplibre-gl-leaflet";
import { CYBERPUNK_STYLE } from "../cyberpunkMapStyle";

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
