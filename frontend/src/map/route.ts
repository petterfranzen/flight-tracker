import L from "leaflet";

const ROUTE_COLOR = "#4db2ff"; // matches --color-accent in FlightMap.css
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

export function createRouteLayer(map: L.Map): RouteLayerHandle {
  let polyline: L.Polyline | null = null;

  function update(route: [number, number][]): void {
    if (route.length <= 1) {
      if (polyline) {
        polyline.remove();
        polyline = null;
      }
      return;
    }
    const smoothed = smoothRoute(route);
    if (polyline) {
      polyline.setLatLngs(smoothed);
    } else {
      polyline = L.polyline(smoothed, { className: "route-line", color: ROUTE_COLOR, weight: 3, dashArray: "6 8" });
      polyline.addTo(map);
    }
  }

  function destroy(): void {
    if (polyline) polyline.remove();
    polyline = null;
  }

  return { update, destroy };
}
