import type { GeoJSONSource } from "maplibre-gl";
import type { FlightMap } from "./map";
import { PLANES_LAYER } from "./planes";
import { ROUTE_LAYER_ID } from "./route";
import type { TrackStatus } from "../types/flight";

const UNCERTAINTY_FALLBACK_COLOR = "#ff5ed8"; // --color-uncertainty in FlightMap.css, if it can't be read
const CIRCLE_VERTICES = 48;
const EARTH_RADIUS_M = 6_371_000;

export const UNCERTAINTY_SOURCE_ID = "flight-uncertainty";
export const UNCERTAINTY_FILL_LAYER_ID = "flight-uncertainty-fill";
export const UNCERTAINTY_LINE_LAYER_ID = "flight-uncertainty-line";

type Point = [number, number];

/** Andrew's monotone chain: the convex hull of `points`, counter-clockwise, without a repeated first point. */
function convexHull(points: Point[]): Point[] {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: Point, a: Point, b: Point) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const build = (input: Point[]): Point[] => {
    const hull: Point[] = [];
    for (const p of input) {
      while (hull.length >= 2 && cross(hull[hull.length - 2], hull[hull.length - 1], p) <= 0) hull.pop();
      hull.push(p);
    }
    hull.pop();
    return hull;
  };
  return [...build(sorted), ...build([...sorted].reverse())];
}

/**
 * The cone of where a silent aircraft may be: the convex hull of its last
 * seen point and the circle of `radiusM` around the estimate (just the circle
 * when the last seen point is inside it). Computed in metres on a tangent
 * plane at the estimate, so the circle is round at any latitude. Returns a
 * closed GeoJSON ring, [lon, lat] per vertex.
 */
export function coneRing(lastSeen: { lat: number; lon: number }, estimate: { lat: number; lon: number; radiusM: number }): Point[] {
  const mPerDegLat = (Math.PI / 180) * EARTH_RADIUS_M;
  const mPerDegLon = mPerDegLat * Math.cos((estimate.lat * Math.PI) / 180);
  const circle: Point[] = [];
  for (let i = 0; i < CIRCLE_VERTICES; i++) {
    const angle = (2 * Math.PI * i) / CIRCLE_VERTICES;
    circle.push([estimate.radiusM * Math.cos(angle), estimate.radiusM * Math.sin(angle)]);
  }
  const lastSeenM: Point = [(lastSeen.lon - estimate.lon) * mPerDegLon, (lastSeen.lat - estimate.lat) * mPerDegLat];
  const inside = Math.hypot(lastSeenM[0], lastSeenM[1]) <= estimate.radiusM;
  const outline = inside ? circle : convexHull([...circle, lastSeenM]);
  const ring = outline.map(([x, y]): Point => [estimate.lon + x / mPerDegLon, estimate.lat + y / mPerDegLat]);
  ring.push(ring[0]);
  return ring;
}

export interface UncertaintyLayerHandle {
  update(status: TrackStatus | null): void;
  destroy(): void;
}

/**
 * The selected aircraft's coverage-gap cone (see coneRing): a low-opacity
 * fill and an outline, under the trail and the plane layers. Empty unless
 * the status carries an estimate. The colour is the theme's uncertainty
 * token, read once from the CSS.
 */
export function createUncertaintyLayer(map: FlightMap): UncertaintyLayerHandle {
  let added = false;
  let latest: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };
  let latestKey = JSON.stringify(latest);

  function data(status: TrackStatus | null): GeoJSON.FeatureCollection {
    const estimate = status?.estimate;
    if (!status || !estimate) return { type: "FeatureCollection", features: [] };
    const ring = coneRing({ lat: status.lastSeenLat, lon: status.lastSeenLon }, estimate);
    return { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [ring] } }] };
  }

  map.whenStyleReady(() => {
    if (added) return;
    const color = getComputedStyle(map.getContainer()).getPropertyValue("--color-uncertainty").trim() || UNCERTAINTY_FALLBACK_COLOR;
    map.gl.addSource(UNCERTAINTY_SOURCE_ID, { type: "geojson", data: latest });
    const before = map.gl.getLayer(ROUTE_LAYER_ID) ? ROUTE_LAYER_ID : map.gl.getLayer(PLANES_LAYER) ? PLANES_LAYER : undefined;
    map.gl.addLayer({ id: UNCERTAINTY_FILL_LAYER_ID, type: "fill", source: UNCERTAINTY_SOURCE_ID, paint: { "fill-color": color, "fill-opacity": 0.14 } }, before);
    map.gl.addLayer(
      {
        id: UNCERTAINTY_LINE_LAYER_ID,
        type: "line",
        source: UNCERTAINTY_SOURCE_ID,
        layout: { "line-join": "round" },
        paint: { "line-color": color, "line-width": 1.5, "line-opacity": 0.8 },
      },
      before,
    );
    added = true;
  });

  function update(status: TrackStatus | null): void {
    const next = data(status);
    const key = JSON.stringify(next);
    if (key === latestKey) return; // same geometry: no redraw
    latestKey = key;
    latest = next;
    if (added) (map.gl.getSource(UNCERTAINTY_SOURCE_ID) as GeoJSONSource | undefined)?.setData(next);
  }

  function destroy(): void {
    if (added && map.gl.getStyle()) {
      map.gl.removeLayer(UNCERTAINTY_LINE_LAYER_ID);
      map.gl.removeLayer(UNCERTAINTY_FILL_LAYER_ID);
      map.gl.removeSource(UNCERTAINTY_SOURCE_ID);
    }
    added = false;
  }

  return { update, destroy };
}
