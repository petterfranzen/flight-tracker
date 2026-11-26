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
 * keeps `previous`'s plane — where it was drawn, which is the one on screen —
 * if it is still live (`isActiveTraffic`: in the air and reported recently)
 * and the response does not return that same aircraft anywhere. Otherwise the
 * response's own plane wins, as does the first frame of a view we have not
 * drawn before. Cells the response does not mention are not drawn at all, so
 * the set stays as sparse as the server thinned it.
 *
 * The "anywhere" is what stops a plane that crossed a cell boundary from being
 * drawn twice: keeping it at the cell it has left would pin a stale copy there
 * (its report is still fresh, so it would survive for DIM_AFTER_MS) while the
 * response returns it in the cell it moved to. Its old cell then takes the
 * server's new winner and the aircraft is drawn once, where it is.
 *
 * The response's plane objects and order are kept wherever they win, so a
 * client's "first discovered" ordering still follows the server's list.
 */
export function keepCellWinners<T extends LiveMarker>(previous: T[], response: T[], cellDeg: number, nowMs: number): T[] {
  const winners = previousWinners(previous, cellDeg, nowMs);

  // Every aircraft the response returns, wherever it returns it: one of these
  // has moved on and must not be kept at the cell it left.
  const returned = new Set(response.map((p) => p.icao24));
  const keepsCell = (held: T | undefined, p: T): held is T => held != null && held.icao24 !== p.icao24 && isStillHeld(held, returned, nowMs);

  const out: T[] = [];
  const seen = new Set<string>();
  for (const p of response) {
    const cell = cellOf(p, cellDeg);
    if (seen.has(cell)) continue; // one per cell, the server's own rule
    seen.add(cell);
    const held = winners.get(cell);
    out.push(keepsCell(held, p) ? held : p);
  }
  return out;
}

/** The plane drawn last frame in each cell: the first there, unless a later one is live and it isn't. */
function previousWinners<T extends LiveMarker>(previous: T[], cellDeg: number, nowMs: number): Map<string, T> {
  const winners = new Map<string, T>();
  for (const p of previous) {
    const cell = cellOf(p, cellDeg);
    const held = winners.get(cell);
    if (!held || replaces(p, held, nowMs)) winners.set(cell, p);
  }
  return winners;
}

function replaces(p: LiveMarker, held: LiveMarker, nowMs: number): boolean {
  return !isActiveTraffic(held, nowMs) && isActiveTraffic(p, nowMs);
}

/** A held plane keeps its cell while it is live and the response doesn't return it anywhere. */
function isStillHeld(held: LiveMarker, returned: Set<string>, nowMs: number): boolean {
  return isActiveTraffic(held, nowMs) && !returned.has(held.icao24);
}
