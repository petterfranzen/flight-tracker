import type { GeoJSONSource } from "maplibre-gl";
import type { FlightMap, RenderedRoute } from "./map";
import { PLANES_LAYER } from "./planes";

const ROUTE_FALLBACK_COLOR = "#3ce0ff"; // --color-accent in FlightMap.css, if it can't be read
const ROUTE_FALLBACK_CASING = "rgba(0, 0, 0, 0.7)"; // --color-plane-outline

const ROUTE_SPLINE_SEGMENTS = 8;

// Two consecutive reports further apart than either of these are a gap in the
// data, not a stretch of the flown path: the solid trail breaks there and the
// missing leg is drawn as its own dashed segment (see routeSegments).
//
// Time is the rule that matters: the hot poll runs every 18 s, so a gap over
// ~60 s means at least two reports were missed. The distance rule is a floor
// only, catching a jump no aircraft could make in that time: 20 km in 60 s is
// 1200 km/h, well past cruise (~900 km/h, i.e. 4.5-15 km per 18-60 s tick).
// The earlier 5 km floor dashed ordinary cruise traffic as it skipped a tick
// (section9-hq#281: "the trails look broken almost all the time").
export const ROUTE_GAP_MAX_SECONDS = 60;
export const ROUTE_GAP_MAX_KM = 20;

/** One point of the selected aircraft's trail, with the time of its report. */
export interface RoutePoint {
  lat: number;
  lon: number;
  /** The report's observedAt, in ms. The dead-reckoned tip carries its report's own time. */
  observedAtMs: number;
}

/** Distance between two lat/lon points, km (haversine). */
function distanceKm(a: RoutePoint, b: RoutePoint): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6_371 * Math.asin(Math.sqrt(h));
}

/**
 * Whether two consecutive reports are far enough apart to be a gap: more than
 * ~60 s of missing time (a missed poll), or more than ~20 km of missing track
 * (a jump no aircraft could make while the time is still under that). Two
 * points at the same instant are the dead-reckoned tip of one report, not a
 * gap between two, however far it has been projected — so the tip connector
 * stays solid.
 */
export function isRouteGap(a: RoutePoint, b: RoutePoint, maxSeconds = ROUTE_GAP_MAX_SECONDS, maxKm = ROUTE_GAP_MAX_KM): boolean {
  const dtSeconds = Math.abs(b.observedAtMs - a.observedAtMs) / 1000;
  if (dtSeconds > maxSeconds) return true;
  if (dtSeconds <= 0) return false;
  return distanceKm(a, b) > maxKm;
}

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
  update(route: RoutePoint[]): void;
  destroy(): void;
}

export const ROUTE_SOURCE_ID = "flight-route";
export const ROUTE_CASING_LAYER_ID = "flight-route-casing";
export const ROUTE_GAP_LAYER_ID = "flight-route-gap";
export const ROUTE_LAYER_ID = "flight-route-line";
/** The trail's bottom-most layer: other map layers insert themselves before this. */
export const ROUTE_BOTTOM_LAYER_ID = ROUTE_CASING_LAYER_ID;

export type RouteSegmentKind = "trail" | "gap";

/** One drawable piece of the trail, in path order: a solid run, or one gap's dashed connector. */
export interface RouteSegment {
  kind: RouteSegmentKind;
  /** [lat, lon] vertices. Solid runs are splined; a gap is its two real endpoints. */
  points: [number, number][];
}

/**
 * The trail split into drawable segments, in path order: each solid run of
 * consecutive reports, splined within itself, and one straight segment across
 * every gap. A run never splines across a gap (the spline is computed per
 * run), and the gap segment is what the layer draws dashed — a real hole in
 * the feed stays visible instead of reading as an uninterrupted path.
 */
export function routeSegments(route: RoutePoint[]): RouteSegment[] {
  const segments: RouteSegment[] = [];
  let run: RoutePoint[] = [];
  const flush = () => {
    if (run.length > 1) segments.push({ kind: "trail", points: smoothRoute(run.map((p): [number, number] => [p.lat, p.lon])) });
    run = [];
  };
  for (let i = 0; i < route.length; i++) {
    const p = route[i];
    const prev = route[i - 1];
    if (prev && isRouteGap(prev, p)) {
      flush();
      segments.push({
        kind: "gap",
        points: [
          [prev.lat, prev.lon],
          [p.lat, p.lon],
        ],
      });
      run = [p];
    } else {
      run.push(p);
    }
  }
  flush();
  return segments;
}

function line(points: [number, number][], kind: RouteSegmentKind): GeoJSON.Feature {
  return {
    type: "Feature",
    properties: { kind },
    geometry: { type: "LineString", coordinates: points.map(([lat, lon]) => [lon, lat]) },
  };
}

function featureCollection(route: RoutePoint[]): GeoJSON.FeatureCollection {
  return { type: "FeatureCollection", features: routeSegments(route).map((s) => line(s.points, s.kind)) };
}

/**
 * The selected aircraft's trail: a GeoJSON source of solid runs (with a darker
 * casing under them so they stay readable over the land) plus dashed segments
 * across any real gap in the reports, all drawn under the plane layers
 * (map/planes.ts), so the selected plane is always drawn over it. The colours
 * are the theme's accent and outline tokens, read once from the CSS.
 */
export function createRouteLayer(map: FlightMap): RouteLayerHandle {
  let added = false;
  let latest: RoutePoint[] = [];

  map.whenStyleReady(() => {
    if (added) return;
    const style = getComputedStyle(map.getContainer());
    const color = style.getPropertyValue("--color-accent").trim() || ROUTE_FALLBACK_COLOR;
    const casing = style.getPropertyValue("--color-plane-outline").trim() || ROUTE_FALLBACK_CASING;
    const before = map.gl.getLayer(PLANES_LAYER) ? PLANES_LAYER : undefined;
    map.gl.addSource(ROUTE_SOURCE_ID, { type: "geojson", data: featureCollection(latest) });
    // Bottom to top: the casing, the gap dashes, the solid accent line.
    map.gl.addLayer(
      {
        id: ROUTE_CASING_LAYER_ID,
        type: "line",
        source: ROUTE_SOURCE_ID,
        filter: ["==", ["get", "kind"], "trail"],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": casing, "line-width": 5, "line-opacity": 0.6 },
      },
      before,
    );
    // Only the missing legs are dashed, and faintly: a break that means
    // something, not a pattern over the whole path.
    map.gl.addLayer(
      {
        id: ROUTE_GAP_LAYER_ID,
        type: "line",
        source: ROUTE_SOURCE_ID,
        filter: ["==", ["get", "kind"], "gap"],
        layout: { "line-cap": "butt", "line-join": "round" },
        paint: { "line-color": color, "line-width": 2.5, "line-opacity": 0.5, "line-dasharray": [1.5, 1.5] },
      },
      before,
    );
    map.gl.addLayer(
      {
        id: ROUTE_LAYER_ID,
        type: "line",
        source: ROUTE_SOURCE_ID,
        filter: ["==", ["get", "kind"], "trail"],
        layout: { "line-cap": "round", "line-join": "round" },
        // The flown path is a solid line: no line-dasharray.
        paint: { "line-color": color, "line-width": 3 },
      },
      before,
    );
    added = true;
  });

  map.renderedRoute = (): RenderedRoute => {
    if (!added) return { trail: [], gaps: [] };
    const segments = routeSegments(latest);
    return { trail: segments.filter((s) => s.kind === "trail").map((s) => s.points), gaps: segments.filter((s) => s.kind === "gap").map((s) => s.points) };
  };

  function update(route: RoutePoint[]): void {
    latest = route;
    if (added) (map.gl.getSource(ROUTE_SOURCE_ID) as GeoJSONSource | undefined)?.setData(featureCollection(route));
  }

  function destroy(): void {
    if (added && map.gl.getStyle()) {
      for (const id of [ROUTE_LAYER_ID, ROUTE_GAP_LAYER_ID, ROUTE_CASING_LAYER_ID]) map.gl.removeLayer(id);
      map.gl.removeSource(ROUTE_SOURCE_ID);
    }
    added = false;
    latest = [];
    map.renderedRoute = () => ({ trail: [], gaps: [] });
  }

  return { update, destroy };
}
