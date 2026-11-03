import type { LiveMarker } from "../types/flight";
import { isActiveTraffic } from "./staleness";

// Two data sources meet at CLUSTER_FETCH_MAX_ZOOM (main.ts): below it the
// thinned, active-traffic overview; at or above it the full /live set, which
// also carries every parked aircraft. So a plane that lands — or a plane the
// overview's one-per-cell thinning drops — left the map the moment the next
// overview response did not return it, and crossing the threshold swapped the
// whole drawn set rather than changing how dense it was (Saito's #2 in
// section9-hq #49).
//
// This holds the frame instead. A plane the overview stops returning is still
// drawn, at its last known position, for OVERVIEW_HOLD_MS, and the planes
// already drawn from /live stay on screen when the map crosses back down. Only
// the density changes at the threshold, not which planes are shown.

/** How long a plane the overview no longer returns keeps being drawn. */
export const OVERVIEW_HOLD_MS = 10 * 60_000;

/** Planes carried between overview frames, with when each was last live. */
export type OverviewHold = Map<string, { plane: LiveMarker; lastLiveAt: number }>;

export function newOverviewHold(): OverviewHold {
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
 * changes density, not membership. A held plane that has gone silent in the
 * air is dropped: the grace is for landings and for the thinning, not for
 * aircraft that stopped reporting. `inView` drops a held plane that has left
 * the viewport: it is remembered but not drawn, and returns if it comes back
 * inside the window. The returned list keeps the response's own planes in the
 * server's order, so a client's discovery order still follows it.
 */
export function holdOverviewFrame(
  hold: OverviewHold,
  response: LiveMarker[],
  drawn: LiveMarker[],
  inView: (p: LiveMarker) => boolean,
  now: number,
): LiveMarker[] {
  for (const p of response) hold.set(p.icao24, { plane: p, lastLiveAt: now });
  for (const p of drawn) if (!hold.has(p.icao24)) hold.set(p.icao24, { plane: p, lastLiveAt: now });

  const out = response.slice();
  const kept = new Set(response.map((p) => p.icao24));
  for (const [icao24, entry] of hold) {
    if (now - entry.lastLiveAt > OVERVIEW_HOLD_MS) {
      hold.delete(icao24);
      continue;
    }
    // Live traffic, or a plane that has landed: a plane that went silent in
    // the air is not held (it is the attrition case, not a landing).
    if (kept.has(icao24) || !inView(entry.plane) || !(isActiveTraffic(entry.plane, now) || entry.plane.onGround === true)) continue;
    kept.add(icao24);
    out.push(entry.plane);
  }
  return out;
}
