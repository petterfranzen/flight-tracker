import type { LiveMarker, TrackState } from "../types/flight";

// A landed plane is kept in the live set for up to 24 h (the server's
// LiveVisibilityWindows), and one that left radar coverage on the ground
// stops reporting where it stopped — at the runway end, not at its gate. The
// map drew it there for as long as the server remembered it. Once it has been
// silent this long there is nothing left to say about it: it is left off the
// map rather than shown at a position that is hours out of date.
//
// A plane a provider has put at a gate is the exception, and is kept however
// old its last report is: there we do know where the plane is, and the gate
// display draws it at its gate (map/gatePlacement.ts). See `GROUND_STATES`.
//
// Chosen to sit well clear of a normal taxi/stand silence (a few minutes) and
// of the 2 h dim threshold (map/staleness.ts), so a parked plane reporting on
// the ground stays drawn and only a genuinely gone-quiet one disappears.
export const LANDED_HIDE_MS = 30 * 60 * 1000;

// States that mean the aircraft is not in the air any more: it is on the
// ground, or the estimator has called the landing. LIVE and COVERAGE_LOST
// (airborne, or silent but still unaccounted for) are not — those are still
// live questions about where the plane is.
//
// AT_GATE is not hidden either. A provider has told us where the plane is (its
// gate), so nothing is stale — the map keeps it and draws it at the gate once
// it is selected. The marker only carries AT_GATE when a provider confirmed a
// gate (backend LiveStateStore.stateOf); an on-ground plane with no
// confirmation still reads ON_GROUND and is hidden as below.
const GROUND_STATES: ReadonlySet<TrackState> = new Set<TrackState>([
  "ON_GROUND",
  "LANDED_INFERRED",
  "LANDED_CONFIRMED",
]);

/**
 * icao24s to leave off the map: aircraft on the ground (or called landed) whose
 * last report is older than LANDED_HIDE_MS. A grounded plane still reporting
 * (taxiing, or parked with ADS-B on) stays drawn, as does a silent airborne one
 * (COVERAGE_LOST) — its position is still worth showing — and so does a plane a
 * provider has put at a gate (AT_GATE): we know where that one is. The marker's
 * own `state` decides it when the snapshot sent one; an older payload without it
 * falls back to `onGround`.
 */
export function hiddenLandedIds(list: LiveMarker[], nowMs: number): Set<string> {
  const hidden = new Set<string>();
  for (const p of list) {
    const grounded = p.state ? GROUND_STATES.has(p.state) : p.onGround === true;
    if (grounded && nowMs - Date.parse(p.observedAt) > LANDED_HIDE_MS) hidden.add(p.icao24);
  }
  return hidden;
}
