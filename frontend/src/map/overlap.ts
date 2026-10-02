import type { LiveMarker } from "../types/flight";

// Two aircraft cannot be this close: wingspans alone are 35-80 m and stands
// are laid out further apart than that. Markers this close are one real
// aircraft plus ghosts: planes that left (or went silent) after their last
// report and still sit at the old position, because the server keeps
// landed aircraft visible for 48 h (see LiveVisibilityWindows).
export const OVERLAP_METERS = 20;

// Below this zoom 20 m is under a pixel, so the overlap isn't visible and
// the scan isn't worth running.
export const OVERLAP_MIN_ZOOM = 13;

const METERS_PER_DEGREE_LAT = 111_320;

/**
 * Of any group of aircraft within OVERLAP_METERS of each other, keeps only
 * the one with the newest `observedAt`. Order of the survivors is preserved.
 */
export function dropStaleOverlaps(list: LiveMarker[]): LiveMarker[] {
  if (list.length < 2) return list;

  const cellLat = OVERLAP_METERS / METERS_PER_DEGREE_LAT;
  // One longitude scale for the whole list: callers pass a single viewport at
  // zoom >= OVERLAP_MIN_ZOOM, whose latitude span is tiny.
  const cosLat = Math.max(0.01, Math.cos((list[0].latitude * Math.PI) / 180));
  const cellLon = cellLat / cosLat;

  const cells = new Map<string, LiveMarker[]>();
  const dropped = new Set<LiveMarker>();
  const key = (r: number, c: number) => `${r},${c}`;
  const withinRange = (a: LiveMarker, b: LiveMarker) => {
    const dy = (a.latitude - b.latitude) * METERS_PER_DEGREE_LAT;
    const dx = (a.longitude - b.longitude) * METERS_PER_DEGREE_LAT * cosLat;
    return dx * dx + dy * dy < OVERLAP_METERS * OVERLAP_METERS;
  };

  // Newest first, so a marker only ever has to beat markers already kept.
  const byFreshness = [...list].sort((a, b) => (a.observedAt < b.observedAt ? 1 : a.observedAt > b.observedAt ? -1 : 0));
  for (const m of byFreshness) {
    const row = Math.floor(m.latitude / cellLat);
    const col = Math.floor(m.longitude / cellLon);
    let shadowed = false;
    for (let r = row - 1; r <= row + 1 && !shadowed; r++) {
      for (let c = col - 1; c <= col + 1 && !shadowed; c++) {
        const bucket = cells.get(key(r, c));
        if (bucket && bucket.some((kept) => withinRange(m, kept))) shadowed = true;
      }
    }
    if (shadowed) {
      dropped.add(m);
      continue;
    }
    const k = key(row, col);
    const bucket = cells.get(k);
    if (bucket) bucket.push(m);
    else cells.set(k, [m]);
  }
  return dropped.size === 0 ? list : list.filter((m) => !dropped.has(m));
}
