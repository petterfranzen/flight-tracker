import L from "leaflet";
import type { ClusterPoint, LiveMarker } from "../types/flight";
import { PLANE_SVG } from "./markers";

const CLUSTER_ICON_MIN_PX = 22;
const CLUSTER_ICON_MAX_PX = 56;

// Square-root, not linear: a cell's on-screen *area* tracks its aircraft
// count, so a cell with 4x the traffic reads as roughly 2x the size.
function clusterIconSize(count: number): number {
  return Math.round(Math.min(CLUSTER_ICON_MAX_PX, CLUSTER_ICON_MIN_PX + 6 * Math.sqrt(count)));
}

// A coarse, 3-bucket read of "how much traffic," not the exact count.
function clusterPlaneCount(count: number): 2 | 3 | 4 {
  if (count < 10) return 2;
  if (count < 50) return 3;
  return 4;
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
    html: `<div class="cluster-icon-mark cluster-icon-mark--${planes}">${PLANE_SVG.repeat(planes)}</div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
  clusterIconCache.set(key, icon);
  return icon;
}

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
 * FlightPositionRepository.findLiveClusteredInBounds's bucket-then-center
 * math exactly, run in JS against a list already in memory (no network
 * round trip) instead of a SQL GROUP BY.
 */
export function clusterPositions(list: LiveMarker[], gridDeg: number): ClusterPoint[] {
  const buckets = new Map<string, ClusterPoint>();
  for (const p of list) {
    const bucketLat = Math.floor(p.latitude / gridDeg) * gridDeg;
    const bucketLon = Math.floor(p.longitude / gridDeg) * gridDeg;
    const key = `${bucketLat},${bucketLon}`;
    const existing = buckets.get(key);
    if (existing) existing.count++;
    else buckets.set(key, { lat: bucketLat + gridDeg / 2, lon: bucketLon + gridDeg / 2, count: 1 });
  }
  return Array.from(buckets.values());
}

export interface ClusterLayerHandle {
  update(clusters: ClusterPoint[]): void;
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
  const entries = new Map<string, { marker: L.Marker; iconKey: string }>();

  function update(clusters: ClusterPoint[]): void {
    const seen = new Set<string>();
    for (const c of clusters) {
      const key = `${c.lat},${c.lon}`;
      seen.add(key);
      const existing = entries.get(key);
      if (existing) {
        const iconKey = `${clusterPlaneCount(c.count)}|${clusterIconSize(c.count)}`;
        if (iconKey !== existing.iconKey) {
          existing.marker.setIcon(clusterIcon(c.count, false));
          existing.iconKey = iconKey;
        }
      } else {
        const marker = L.marker([c.lat, c.lon], { icon: clusterIcon(c.count, true) });
        marker.on("click", () => map.setView([c.lat, c.lon], map.getZoom() + 3, { animate: false }));
        marker.addTo(map);
        // The entering icon carries a one-shot fade-in; recorded under a key
        // that never matches so the first real change swaps in the plain one.
        entries.set(key, { marker, iconKey: "entering" });
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
