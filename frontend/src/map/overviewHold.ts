import type { LiveMarker } from "../types/flight";

// Two data sources meet at CLUSTER_FETCH_MAX_ZOOM (main.ts): below it the
// thinned, active-traffic overview; at or above it the full /live set, which
// also carries every parked aircraft. So a plane that lands — or a plane the
// overview's one-per-cell thinning drops — left the map the moment the next
// overview response did not return it, and crossing the threshold swapped the
// whole drawn set rather than changing how dense it was (Saito's #2 in
// section9-hq #49).
//
// This holds the frame instead. A *landed* plane the overview stops returning
// is still drawn, at its last known position, for OVERVIEW_HOLD_MS, and the
// planes already drawn from /live stay on screen when the map crosses back
// down. Only the density changes at the threshold, not which planes are shown.
//
// Landed only, on purpose: the overview holds one plane per cell, so a plane
// that lost its cell to another one is drawn within half an icon of it. Holding
// that plane would hide the new winner (map/declutter.ts keeps the one drawn
// first), which is the churn Saito's #1 is about, not this.

/** How long a plane the overview no longer returns keeps being drawn. */
export const OVERVIEW_HOLD_MS = 10 * 60_000;

/** Planes carried between overview frames, with when each was last live. */
export type OverviewHold<T extends LiveMarker = LiveMarker> = Map<string, { plane: T; lastLiveAt: number }>;

export function newOverviewHold<T extends LiveMarker>(): OverviewHold<T> {
  return new Map();
}

/**
 * The list to draw for one fresh overview response: its own planes, plus every
 * plane drawn for this view that the response no longer returns, for
 * OVERVIEW_HOLD_MS after it was last live.
 *
 * `drawn` is what is on screen now (the previous overview's planes, and — at
 * the threshold — the /live ones the map was drawing before it crossed back
 * down); a plane only it knows about is given the same grace, so the crossing
 * changes density, not membership. Only planes whose last report is on the
 * ground are held: an airborne one the thinning drops is another cell's winner
 * now, and holding it would hide that one. `inView` drops a held plane that has left
 * the viewport: it is remembered but not drawn, and returns if it comes back
 * inside the window. The returned list keeps the response's own planes in the
 * server's order, so a client's discovery order still follows it.
 */
export function holdOverviewFrame<T extends LiveMarker>(
  hold: OverviewHold<T>,
  response: T[],
  drawn: T[],
  inView: (p: T) => boolean,
  now: number,
): T[] {
  for (const p of response) hold.set(p.icao24, { plane: p, lastLiveAt: now });
  for (const p of drawn) if (!hold.has(p.icao24)) hold.set(p.icao24, { plane: p, lastLiveAt: now });

  const out = response.slice();
  const kept = new Set(response.map((p) => p.icao24));
  for (const [icao24, entry] of hold) {
    if (now - entry.lastLiveAt > OVERVIEW_HOLD_MS) {
      hold.delete(icao24);
      continue;
    }
    // Landed planes only: one that went silent in the air, or that lost its
    // cell to another plane, must not stay behind (see the note above).
    if (kept.has(icao24) || !inView(entry.plane) || entry.plane.onGround !== true) continue;
    kept.add(icao24);
    out.push(entry.plane);
  }
  return out;
}
