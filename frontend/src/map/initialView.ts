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
/**
 * Zooms tried, in order, around the default centre before leaving the area:
 * a phone's small window (or a quiet night) can hold too few planes at zoom 8
 * and still plenty one or two levels out (the zoomed-out map draws the most
 * active aircraft individually, so these are not bubbles-only views).
 */
export const LOCAL_ZOOMS = [INITIAL_ZOOM, 7, 6];
/** Below this many planes even at the widest local zoom, the area is empty: look elsewhere. */
export const LOCAL_EMPTY_BELOW = 10;

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
 * Stays where the default centre is: the first of LOCAL_ZOOMS that has enough
 * planes (one level closer if crowded at zoom 8). Only when that area is empty
 * even at the widest local zoom does it move to the busiest window in the
 * world (at zoom 8), ties going to the one nearest the default. A sparse but
 * not empty area keeps the default view.
 */
export function pickInitialView(clusters: ClusterPoint[], defaultCenter: LatLon, viewport: { width: number; height: number }): InitialView | null {
  let widest = 0;
  for (const zoom of LOCAL_ZOOMS) {
    const here = planesInWindow(clusters, defaultCenter, zoom, viewport);
    widest = here;
    if (here >= INITIAL_MIN_PLANES) return { ...defaultCenter, zoom: zoom === INITIAL_ZOOM ? zoomFor(here) : zoom, planes: here };
  }
  if (widest >= LOCAL_EMPTY_BELOW) return null;

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
