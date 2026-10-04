import type { ClusterPoint, LiveMarker } from "../types/flight";

// Pure cluster maths, kept free of Leaflet so it can be unit-tested in Node.

// Web Mercator tile math (256px tiles, doubling every zoom level) —
// approximate (real px/degree varies with latitude), same simplification
// this app's other zoom-driven sizing uses.
const CLUSTER_TARGET_PX = 110;

export function gridDegForZoom(zoom: number): number {
  const degPerPixel = 360 / (256 * Math.pow(2, zoom));
  return CLUSTER_TARGET_PX * degPerPixel;
}

/**
 * MAX_INDIVIDUAL_MARKERS' own client-side bucketing — mirrors
 * LiveStateStore.clustered's bucket-then-centroid math exactly, run in JS
 * against a list already in memory (no network round trip). Each cluster is
 * placed at the mean position of the aircraft in it, not at its grid cell's
 * centre: a centre-placed bubble can sit in empty sea or over the wrong
 * country, and jumps whenever the zoom changes the grid.
 */
export function clusterPositions(list: LiveMarker[], gridDeg: number): ClusterPoint[] {
  const cells = new Map<string, { lat: number; lon: number; count: number }>();
  for (const p of list) {
    const key = `${Math.floor(p.latitude / gridDeg)},${Math.floor(p.longitude / gridDeg)}`;
    const cell = cells.get(key);
    if (cell) {
      cell.lat += p.latitude;
      cell.lon += p.longitude;
      cell.count++;
    } else {
      cells.set(key, { lat: p.latitude, lon: p.longitude, count: 1 });
    }
  }
  return Array.from(cells.values(), (c) => ({ lat: c.lat / c.count, lon: c.lon / c.count, count: c.count }));
}

/**
 * A key for a cluster that survives its position moving: the grid cell it
 * belongs to (a cluster always lies inside its own cell), plus the grid
 * itself so clusters computed at different zooms never share a key. With
 * centroid placement a cluster drifts as aircraft move; keying on its
 * position would tear down and rebuild its marker on every update.
 */
export function clusterCellKey(c: ClusterPoint, gridDeg: number): string {
  return `${gridDeg}:${Math.floor(c.lat / gridDeg)},${Math.floor(c.lon / gridDeg)}`;
}
