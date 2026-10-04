import L from "leaflet";
import type { ClusterPoint } from "../types/flight";
import { clusterCellKey } from "./clusterMath";

const CLUSTER_ICON_MIN_PX = 48;
const CLUSTER_ICON_MAX_PX = 112;

// Square-root, not linear: a cell's on-screen *area* tracks its aircraft
// count, so a cell with 4x the traffic reads as roughly 2x the size.
function clusterIconSize(count: number): number {
  return Math.round(Math.min(CLUSTER_ICON_MAX_PX, CLUSTER_ICON_MIN_PX + 7 * Math.sqrt(count)));
}

// A scattered swarm, not a formation: [x, y, heading°, scale] per plane in a
// 100x100 box, ordered centre-outward so a bigger bucket is the same swarm
// with more planes around it, never a different shape. Headings share a loose
// north-east drift with a lot of spread. Fixed, hand-rolled data so every
// cluster of a bucket renders identically and its icon can be cached.
const SWARM: ReadonlyArray<readonly [number, number, number, number]> = [
  [47, 56, 7, 1.08], [60, 52, 38, 0.87], [41, 42, 94, 1.05], [56, 38, 10, 1.05],
  [33, 54, 23, 1.13], [59, 65, 16, 0.93], [71, 45, 66, 1.03], [73, 58, -3, 0.92],
  [35, 69, -4, 0.85], [28, 33, 6, 0.94], [69, 28, 99, 1.01], [15, 53, -1, 0.89],
  [47, 81, 81, 0.91], [88, 40, 48, 0.9], [36, 16, 19, 0.98], [72, 83, 75, 1.04],
];

// Coarse buckets of "how much traffic", not the exact count.
function clusterPlaneCount(count: number): number {
  if (count < 10) return 5;
  if (count < 50) return 8;
  if (count < 200) return 11;
  if (count < 1000) return 14;
  return SWARM.length;
}

// Same dart as PLANE_SVG (markers.ts), centred on (12, 11) and placed with
// one transform per plane. One <svg> with N <path>s rather than N nested
// <svg>s: a zoomed-out map shows hundreds of these.
const DART = "M12 2 L19 20 L12 16 L5 20 Z";

function swarmSvg(planes: number): string {
  const paths = SWARM.slice(0, planes)
    .map(([x, y, heading, scale]) => `<path d="${DART}" transform="translate(${x} ${y}) rotate(${heading}) scale(${scale * 1.15}) translate(-12 -11)"/>`)
    .join("");
  return `<svg viewBox="0 0 100 100" aria-hidden="true">${paths}</svg>`;
}

const clusterIconCache = new Map<string, L.DivIcon>();

function clusterIcon(count: number, entering: boolean): L.DivIcon {
  const size = clusterIconSize(count);
  const planes = clusterPlaneCount(count);
  const key = `${planes}|${size}|${entering}`;
  const cached = clusterIconCache.get(key);
  if (cached) return cached;
  const icon = new L.DivIcon({
    className: `cluster-icon${entering ? " plane-icon--entering" : ""}`,
    html: `<div class="cluster-icon-mark cluster-icon-mark--${planes}">${swarmSvg(planes)}</div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
  clusterIconCache.set(key, icon);
  return icon;
}

export interface ClusterLayerHandle {
  /** `gridDeg`: the grid these clusters were computed with (see clusterCellKey). */
  update(clusters: ClusterPoint[], gridDeg: number): void;
  destroy(): void;
}

/**
 * One aggregated cell, rendered below CLUSTER_FETCH_MAX_ZOOM instead of
 * individual AircraftMarkers (server clusters), or above it as
 * MAX_INDIVIDUAL_MARKERS' backstop (client clusters) — same rendering
 * either way, so one layer serves both call sites (main.ts picks which
 * list to hand it; they're never both non-empty at once). Clicking zooms
 * in three levels, undamped.
 */
export function createClusterLayer(map: L.Map): ClusterLayerHandle {
  // iconKey: which cached icon the marker currently shows. setIcon() tears
  // down and rebuilds the marker's DOM, so it's only called when the
  // bucket's size/plane-count actually changed — previously every bubble
  // was rebuilt on every update, including once per WebSocket frame.
  // lat/lon: where the marker currently sits (clusters sit at the mean
  // position of their aircraft, so it drifts); the click handler reads
  // `cluster` so it always zooms to the latest position, not the one the
  // marker was created at.
  const entries = new Map<string, { marker: L.Marker; iconKey: string; lat: number; lon: number; cluster: ClusterPoint }>();

  function update(clusters: ClusterPoint[], gridDeg: number): void {
    const seen = new Set<string>();
    // Fade new bubbles in only when the layer was empty (first paint, or
    // coming from individual markers). On a zoom step every cell key
    // changes, and fading the whole set in again read as the map redrawing
    // from scratch each time.
    const animateEntering = entries.size === 0;
    for (const c of clusters) {
      const key = clusterCellKey(c, gridDeg);
      seen.add(key);
      const existing = entries.get(key);
      if (existing) {
        existing.cluster = c;
        if (existing.lat !== c.lat || existing.lon !== c.lon) {
          existing.marker.setLatLng([c.lat, c.lon]);
          existing.lat = c.lat;
          existing.lon = c.lon;
        }
        const iconKey = `${clusterPlaneCount(c.count)}|${clusterIconSize(c.count)}`;
        if (iconKey !== existing.iconKey) {
          existing.marker.setIcon(clusterIcon(c.count, false));
          existing.iconKey = iconKey;
        }
      } else {
        const marker = L.marker([c.lat, c.lon], { icon: clusterIcon(c.count, animateEntering) });
        const entry = {
          marker,
          // The entering icon carries a one-shot fade-in; recorded under a key
          // that never matches so the first real change swaps in the plain one.
          iconKey: animateEntering ? "entering" : `${clusterPlaneCount(c.count)}|${clusterIconSize(c.count)}`,
          lat: c.lat,
          lon: c.lon,
          cluster: c,
        };
        marker.on("click", () => map.setView([entry.cluster.lat, entry.cluster.lon], map.getZoom() + 3, { animate: false }));
        marker.addTo(map);
        entries.set(key, entry);
      }
    }
    for (const [key, entry] of entries) {
      if (!seen.has(key)) {
        entry.marker.remove();
        entries.delete(key);
      }
    }
  }

  function destroy(): void {
    for (const entry of entries.values()) entry.marker.remove();
    entries.clear();
  }

  return { update, destroy };
}
