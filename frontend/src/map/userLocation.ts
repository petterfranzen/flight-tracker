import type { GeoJSONSource } from "maplibre-gl";
import type { FlightMap } from "./map";
import { PLANES_LAYER } from "./planes";
import { ROUTE_LAYER_ID } from "./route";
import { cssToken, withAlpha } from "./glImages";

/**
 * The "you are here" dot for the locate button (ui/locate.ts): a GL layer,
 * not DOM, drawn from the same theme tokens as the planes and airports and
 * added under them so it never covers traffic. Browser-only — the position
 * it is given never leaves the page (no API call, no storage).
 */
const SOURCE = "user-location";
const HALO_LAYER = "user-location-halo";
const DOT_LAYER = "user-location-dot";
// A fixed-size mark in screen px, like the airport dots: the dot marks a
// person, not a measured area, so it does not scale with zoom.
const DOT_RADIUS_PX = 7;
const HALO_RADIUS_PX = 17;

export interface UserLocation {
  lat: number;
  lon: number;
}

export interface UserLocationLayer {
  /** Draws the dot at this position, or clears it when null. */
  set(pos: UserLocation | null): void;
  destroy(): void;
}

export function createUserLocationLayer(map: FlightMap): UserLocationLayer {
  const gl = map.gl;
  let added = false;
  let destroyed = false;
  let current: UserLocation | null = null;

  function data(): GeoJSON.FeatureCollection {
    return {
      type: "FeatureCollection",
      features: current
        ? [{ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [current.lon, current.lat] } }]
        : [],
    };
  }

  map.whenStyleReady(() => {
    if (destroyed) return;
    const accent = cssToken("--color-accent", "#3ce0ff");
    const bg = cssToken("--color-bg", "#050608");
    gl.addSource(SOURCE, { type: "geojson", data: data() });
    // Under the route/planes/airports when they already exist; on top of the
    // basemap alone when this runs first (they are added above it later).
    const before = [ROUTE_LAYER_ID, PLANES_LAYER, "airports"].find((id) => gl.getLayer(id));
    gl.addLayer(
      {
        id: HALO_LAYER,
        type: "circle",
        source: SOURCE,
        paint: { "circle-radius": HALO_RADIUS_PX, "circle-color": withAlpha(accent, 0.18), "circle-blur": 0.5 },
      },
      before,
    );
    gl.addLayer(
      {
        id: DOT_LAYER,
        type: "circle",
        source: SOURCE,
        paint: {
          "circle-radius": DOT_RADIUS_PX,
          "circle-color": accent,
          "circle-stroke-color": bg,
          "circle-stroke-width": 3,
        },
      },
      before,
    );
    added = true;
    // A position set before the style was ready: apply it now.
    if (current) (gl.getSource(SOURCE) as GeoJSONSource | undefined)?.setData(data());
  });

  function set(pos: UserLocation | null): void {
    current = pos;
    if (!added) return; // applied in the style-ready callback above
    (gl.getSource(SOURCE) as GeoJSONSource | undefined)?.setData(data());
  }

  map.renderedUserLocation = () => {
    if (!added) return null;
    const f = gl.queryRenderedFeatures(undefined, { layers: [DOT_LAYER] })[0];
    if (!f) return null;
    const [lon, lat] = (f.geometry as GeoJSON.Point).coordinates;
    const at = map.project(lat, lon);
    return { lat, lon, x: at.x, y: at.y };
  };

  return {
    set,
    destroy() {
      destroyed = true;
      if (added && gl.getStyle()) {
        for (const id of [DOT_LAYER, HALO_LAYER]) if (gl.getLayer(id)) gl.removeLayer(id);
        if (gl.getSource(SOURCE)) gl.removeSource(SOURCE);
      }
      added = false;
      map.renderedUserLocation = () => null;
    },
  };
}
