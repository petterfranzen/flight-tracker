import type { GeoJSONSource } from "maplibre-gl";
import type { FlightMap } from "./map";
import { PLANES_LAYER } from "./planes";

const ROUTE_FALLBACK_COLOR = "#3ce0ff"; // --color-accent in FlightMap.css, if it can't be read
const ROUTE_SPLINE_SEGMENTS = 8;

// Centripetal Catmull-Rom (alpha = 0.5). The uniform spline (alpha = 0)
// overshoots and can loop back on itself where the reports are unevenly
// spaced or the turn is sharp — exactly the hook at the end of a runway
// exit, where a sparse report or two sits either side of a hard turn.
// Centripetal parameterisation (Yuksel et al., "On the Parameterization of
// Catmull-Rom Curves") has no cusps or self-intersections and stays closer to
// the control points at a sharp turn, at the cost of the knots no longer
// being the integer index.
//
// Parameterisation alone does not guarantee it stays inside the track: an
// unevenly spaced 90° turn still bulges past the corner report. So each
// smoothed point is also clamped to the bounding box of the four reports the
// segment is built from — the trail can never hook outside where the plane
// actually was. On a gentle trail nothing is clamped; only a hard turn is.
const ROUTE_ALPHA = 0.5;
// A zero-length knot step (two identical reports) would divide by zero; a
// tiny floor keeps the parameterisation monotone instead.
const KNOT_EPS = 1e-9;

type Point = [number, number];

function knotStep(a: Point, b: Point): number {
  return Math.pow(Math.max(Math.hypot(b[0] - a[0], b[1] - a[1]), KNOT_EPS), ROUTE_ALPHA);
}

function lerpPoint(a: Point, b: Point, t: number): Point {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

/** `p` clamped into the bounding box of `points` (no overshoot outside the reports). */
function clampToBox(p: Point, points: Point[]): Point {
  let latMin = Infinity;
  let latMax = -Infinity;
  let lonMin = Infinity;
  let lonMax = -Infinity;
  for (const [lat, lon] of points) {
    latMin = Math.min(latMin, lat);
    latMax = Math.max(latMax, lat);
    lonMin = Math.min(lonMin, lon);
    lonMax = Math.max(lonMax, lon);
  }
  return [Math.min(latMax, Math.max(latMin, p[0])), Math.min(lonMax, Math.max(lonMin, p[1]))];
}

/** The centripetal Catmull-Rom point at parameter t in [0,1] between p1 and p2, clamped to the four control points' box. */
function catmullRomPoint(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const t0 = 0;
  const t1 = t0 + knotStep(p0, p1);
  const t2 = t1 + knotStep(p1, p2);
  const t3 = t2 + knotStep(p2, p3);
  const tt = t1 + (t2 - t1) * t;
  const a1 = lerpPoint(p0, p1, (tt - t0) / (t1 - t0));
  const a2 = lerpPoint(p1, p2, (tt - t1) / (t2 - t1));
  const a3 = lerpPoint(p2, p3, (tt - t2) / (t3 - t2));
  const b1 = lerpPoint(a1, a2, (tt - t0) / (t2 - t0));
  const b2 = lerpPoint(a2, a3, (tt - t1) / (t3 - t1));
  return clampToBox(lerpPoint(b1, b2, (tt - t1) / (t2 - t1)), [p0, p1, p2, p3]);
}

/**
 * Catmull-Rom spline through `points`, passing exactly through every real
 * report — this is about rendering the straight-segment jaggedness between
 * sparse ADS-B reports as a smooth curve, not about filtering GPS noise out
 * of the data itself. Falls back to the original points untouched below 3
 * of them, where a spline segment isn't well-defined anyway.
 */
export function smoothRoute(points: Point[]): Point[] {
  if (points.length < 3) return points;
  const at = (i: number) => points[Math.max(0, Math.min(points.length - 1, i))];
  const result: Point[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);
    for (let s = 0; s < ROUTE_SPLINE_SEGMENTS; s++) {
      result.push(catmullRomPoint(p0, p1, p2, p3, s / ROUTE_SPLINE_SEGMENTS));
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
