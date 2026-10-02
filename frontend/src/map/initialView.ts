import type { ClusterPoint } from "../types/flight";

// Where the map opens. A wide opening view (zoom 6 and out) shows nothing but
// aggregated bubbles, which reads as broken. Instead open at a zoom where
// individual aircraft are drawn (>= CLUSTER_FETCH_MAX_ZOOM in main.ts), over a
// part of the world that currently has a good amount of traffic. The decision
// is made once, at boot, from one coarse world summary (the server's cluster
// endpoint at a large grid) and is pure so it can be unit-tested.

/** Fewer than this many planes in the opening window looks empty. */
export const INITIAL_MIN_PLANES = 25;
/** More than this at INITIAL_ZOOM and the window is crowded: open one level closer. */
export const INITIAL_MAX_PLANES = 300;
export const INITIAL_ZOOM = 8;
export const INITIAL_ZOOM_DENSE = 9;

export interface LatLon {
  lat: number;
  lon: number;
}

export interface InitialView extends LatLon {
  zoom: number;
  /** Planes the summary puts inside the chosen window. */
  planes: number;
}

/** Planes the summary places inside a `viewport`-sized window centred on `center` at `zoom`. */
export function planesInWindow(clusters: ClusterPoint[], center: LatLon, zoom: number, viewport: { width: number; height: number }): number {
  // Web Mercator, 256px tiles: degrees of longitude per pixel, and latitude
  // degrees shrink with cos(lat). Same approximation the rest of the map uses.
  const degLonPerPx = 360 / (256 * Math.pow(2, zoom));
  const halfLon = (viewport.width / 2) * degLonPerPx;
  const halfLat = (viewport.height / 2) * degLonPerPx * Math.cos((center.lat * Math.PI) / 180);
  let n = 0;
  for (const c of clusters) {
    if (Math.abs(c.lat - center.lat) <= halfLat && Math.abs(c.lon - center.lon) <= halfLon) n += c.count;
  }
  return n;
}

function zoomFor(planes: number): number {
  return planes > INITIAL_MAX_PLANES ? INITIAL_ZOOM_DENSE : INITIAL_ZOOM;
}

/**
 * The opening view, or null to keep the default (no usable traffic data).
 * Prefers the default centre when it already has enough planes; otherwise
 * the busiest window in the world, ties going to the one nearest the default.
 */
export function pickInitialView(clusters: ClusterPoint[], defaultCenter: LatLon, viewport: { width: number; height: number }): InitialView | null {
  const here = planesInWindow(clusters, defaultCenter, INITIAL_ZOOM, viewport);
  if (here >= INITIAL_MIN_PLANES) return { ...defaultCenter, zoom: zoomFor(here), planes: here };

  let best: InitialView | null = null;
  let bestDist = Infinity;
  for (const c of clusters) {
    const candidate = { lat: c.lat, lon: c.lon };
    const planes = planesInWindow(clusters, candidate, INITIAL_ZOOM, viewport);
    if (planes < INITIAL_MIN_PLANES) continue;
    const dist = Math.hypot(c.lat - defaultCenter.lat, c.lon - defaultCenter.lon);
    if (!best || planes > best.planes || (planes === best.planes && dist < bestDist)) {
      best = { ...candidate, zoom: zoomFor(planes), planes };
      bestDist = dist;
    }
  }
  return best;
}
