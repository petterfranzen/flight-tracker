import type { LiveMarker } from "../types/flight";
import { isActiveTraffic } from "./staleness";

// The zoomed-out overview returns one plane per cell (LiveStateStore.discovered,
// "first discovered wins"), recomputed on every 10 s refresh. So a cell's
// winner changes as planes move between cells — a marker blinks out and
// another takes its place while the map is standing still (Saito's #1 in
// section9-hq #49).
//
// This keeps the cell's winner instead: of the planes the server returns for a
// cell, the one already drawn there is kept while it is still live and still in
// that cell, and only then does the server's new pick take over.

/** The grid cell a position falls in at `cellDeg`, bucketed exactly as the server buckets it. */
export function cellOf(p: Pick<LiveMarker, "latitude" | "longitude">, cellDeg: number): string {
  return `${Math.floor(p.latitude / cellDeg)},${Math.floor(p.longitude / cellDeg)}`;
}

/**
 * One plane per cell, keeping each cell's current winner.
 *
 * `previous` is the frame drawn for this zoom and bbox last time (the cached
 * response), `response` the fresh one. A cell the response returns a plane for
 * keeps `previous`'s plane — at its position, which is the one on screen — if
 * it is still live (`isActiveTraffic`: in the air and reported recently) and
 * still in that cell (its cell is recomputed from where it now is, so a plane
 * that has moved on has left it). Otherwise the response's own plane wins, as
 * does the first frame of a view we have not drawn before. Cells the response
 * does not mention are not drawn at all, so the set stays as sparse as the
 * server thinned it.
 *
 * The response's plane objects and order are kept wherever they win, so a
 * client's "first discovered" ordering still follows the server's list.
 */
export function keepCellWinners(previous: LiveMarker[], response: LiveMarker[], cellDeg: number, nowMs: number): LiveMarker[] {
  const winners = new Map<string, LiveMarker>();
  for (const p of previous) {
    const cell = cellOf(p, cellDeg);
    const held = winners.get(cell);
    if (!held || (!isActiveTraffic(held, nowMs) && isActiveTraffic(p, nowMs))) winners.set(cell, p);
  }

  const out: LiveMarker[] = [];
  const seen = new Set<string>();
  for (const p of response) {
    const cell = cellOf(p, cellDeg);
    if (seen.has(cell)) continue; // one per cell, the server's own rule
    seen.add(cell);
    const held = winners.get(cell);
    out.push(held && held.icao24 !== p.icao24 && isActiveTraffic(held, nowMs) ? held : p);
  }
  return out;
}
