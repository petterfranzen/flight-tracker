import type { LiveMarker } from "../types/flight";

// The server keeps landed aircraft visible for 48 h (LiveVisibilityWindows),
// and a parked plane often stops reporting. So the map can show positions that
// are hours old, or a plane that has since left a stand under whatever parked
// there next. Two rules keep that from looking like live traffic:
//  - a report older than DIM_AFTER_MS is drawn dimmed (it may still be right:
//    a plane can sit at a gate for a day, it just isn't live);
//  - an aircraft with a newer one on top of it is not drawn at all.

// A report older than this means the aircraft has been silent (parked, or
// out of coverage) for that long.
export const DIM_AFTER_MS = 2 * 60 * 60 * 1000;

// Two aircraft cannot be this close: wingspans alone are 35-80 m and stands
// are laid out further apart than that. Of any group within this distance,
// only the newest report is real; the rest are ghosts.
export const OVERLAP_METERS = 20;

// Below this zoom 20 m is under a pixel, so the overlap isn't visible and
// the scan isn't worth running.
export const OVERLAP_MIN_ZOOM = 13;

const METERS_PER_DEGREE_LAT = 111_320;

/**
 * icao24s of aircraft that have a *newer* report within OVERLAP_METERS of
 * them. The newest of each group is never included.
 */
export function findShadowedIds(list: LiveMarker[]): Set<string> {
  const shadowed = new Set<string>();
  if (list.length < 2) return shadowed;

  const cellLat = OVERLAP_METERS / METERS_PER_DEGREE_LAT;
  // One longitude scale for the whole list: callers pass a single viewport at
  // zoom >= OVERLAP_MIN_ZOOM, whose latitude span is tiny.
  const cosLat = Math.max(0.01, Math.cos((list[0].latitude * Math.PI) / 180));
  const cellLon = cellLat / cosLat;

  const cells = new Map<string, LiveMarker[]>();
  const key = (r: number, c: number) => `${r},${c}`;
  const withinRange = (a: LiveMarker, b: LiveMarker) => {
    const dy = (a.latitude - b.latitude) * METERS_PER_DEGREE_LAT;
    const dx = (a.longitude - b.longitude) * METERS_PER_DEGREE_LAT * cosLat;
    return dx * dx + dy * dy < OVERLAP_METERS * OVERLAP_METERS;
  };

  // Newest first, so a marker only ever has to be compared with markers
  // already known to be newer than it.
  const byFreshness = [...list].sort((a, b) => (a.observedAt < b.observedAt ? 1 : a.observedAt > b.observedAt ? -1 : 0));
  for (const m of byFreshness) {
    const row = Math.floor(m.latitude / cellLat);
    const col = Math.floor(m.longitude / cellLon);
    let isShadowed = false;
    for (let r = row - 1; r <= row + 1 && !isShadowed; r++) {
      for (let c = col - 1; c <= col + 1 && !isShadowed; c++) {
        const bucket = cells.get(key(r, c));
        if (bucket && bucket.some((newer) => withinRange(m, newer))) isShadowed = true;
      }
    }
    if (isShadowed) {
      shadowed.add(m.icao24);
      continue;
    }
    const k = key(row, col);
    const bucket = cells.get(k);
    if (bucket) bucket.push(m);
    else cells.set(k, [m]);
  }
  return shadowed;
}

/** icao24s whose last report is older than DIM_AFTER_MS. */
export function agedIds(list: LiveMarker[], nowMs: number): Set<string> {
  const aged = new Set<string>();
  for (const p of list) {
    if (nowMs - Date.parse(p.observedAt) > DIM_AFTER_MS) aged.add(p.icao24);
  }
  return aged;
}
