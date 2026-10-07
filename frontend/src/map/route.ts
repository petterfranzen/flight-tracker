import type { GeoJSONSource } from "maplibre-gl";
import type { FlightMap } from "./map";
import { PLANES_LAYER } from "./planes";

const ROUTE_FALLBACK_COLOR = "#3ce0ff"; // --color-accent in FlightMap.css, if it can't be read
const ROUTE_SPLINE_SEGMENTS = 8;

/**
 * Catmull-Rom spline through `points`, passing exactly through every real
 * report — this is about rendering the straight-segment jaggedness between
 * sparse ADS-B reports as a smooth curve, not about filtering GPS noise out
 * of the data itself. Falls back to the original points untouched below 3
 * of them, where a spline segment isn't well-defined anyway.
 */
export function smoothRoute(points: [number, number][]): [number, number][] {
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
        0.5 * (2 * lat1 + (-lat0 + lat2) * t + (2 * lat0 - 5 * lat1 + 4 * lat2 - lat3) * t2 + (-lat0 + 3 * lat1 - 3 * lat2 + lat3) * t3);
      const lon =
        0.5 * (2 * lon1 + (-lon0 + lon2) * t + (2 * lon0 - 5 * lon1 + 4 * lon2 - lon3) * t2 + (-lon0 + 3 * lon1 - 3 * lon2 + lon3) * t3);
      result.push([lat, lon]);
    }
  }
  result.push(points[points.length - 1]);
  return result;
}

export interface RouteLayerHandle {
  update(route: [number, number][]): void;
  destroy(): void;
}

export const ROUTE_SOURCE_ID = "flight-route";
export const ROUTE_LAYER_ID = "flight-route-line";

/**
 * The selected aircraft's trail: a GeoJSON source and a dashed line layer
 * on top of the basemap, under the plane layers (map/planes.ts), so the
 * selected plane is always drawn over it. The colour is the theme's accent
 * token, read once from the CSS.
 */
export function createRouteLayer(map: FlightMap): RouteLayerHandle {
  let added = false;
  let latest: [number, number][] = [];

  function data(route: [number, number][]): GeoJSON.Feature {
    const coordinates = route.length > 1 ? smoothRoute(route).map(([lat, lon]) => [lon, lat]) : [];
    return { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates } };
  }

  map.whenStyleReady(() => {
    if (added) return;
    const color = getComputedStyle(map.getContainer()).getPropertyValue("--color-accent").trim() || ROUTE_FALLBACK_COLOR;
    map.gl.addSource(ROUTE_SOURCE_ID, { type: "geojson", data: data(latest) });
    map.gl.addLayer(
      {
        id: ROUTE_LAYER_ID,
        type: "line",
        source: ROUTE_SOURCE_ID,
        layout: { "line-cap": "round", "line-join": "round" },
        // Dashes are in line widths: 6 px on, 8 px off at 3 px wide.
        paint: { "line-color": color, "line-width": 3, "line-dasharray": [2, 8 / 3] },
      },
      map.gl.getLayer(PLANES_LAYER) ? PLANES_LAYER : undefined,
    );
    added = true;
  });

  function update(route: [number, number][]): void {
    latest = route;
    if (added) (map.gl.getSource(ROUTE_SOURCE_ID) as GeoJSONSource | undefined)?.setData(data(route));
  }

  function destroy(): void {
    if (added && map.gl.getStyle()) {
      map.gl.removeLayer(ROUTE_LAYER_ID);
      map.gl.removeSource(ROUTE_SOURCE_ID);
    }
    added = false;
  }

  return { update, destroy };
}
