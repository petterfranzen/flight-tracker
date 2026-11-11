// Pure, map-free: which stretch of an aircraft's history belongs to the leg it
// is flying right now.
//
// A selection's trail is one flight, not every report the airframe has made in
// the last 6 h: an out-and-back or a turnaround inside that window is a long,
// complex trail that corrects itself the instant the dossier's leg start
// arrives — the ghost trail that was reported. The dossier knows that leg
// start; this module is the fallback for when it does not.

/**
 * Reports this far apart or further are a new leg, not one continuous flight:
 * the feed lost the plane for longer than any real leg reports continuously.
 */
export const LEG_RUN_GAP_MAX_MS = 20 * 60 * 1000;

/**
 * How far back the fallback history request reaches when there is no leg start
 * to ask from. Long enough to contain the last leg's own reports, short enough
 * that it is not the whole 6 h of airframe history the ghost trail came from.
 */
export const TRAIL_FALLBACK_WINDOW_MS = 2 * 60 * 60 * 1000;

/** As little of a report as this needs: when it was made, and where the plane was. */
export interface TimedReport {
  observedAt: string;
  /** Absent on partial sources; a report without it never marks a boundary. */
  onGround?: boolean | null;
}

/**
 * The last continuous run of `points`: chronological, from the most recent
 * boundary to the newest report. A boundary is a gap of more than `gapMaxMs`
 * between two consecutive reports, or a takeoff — a report on the ground
 * followed by one in the air, the start of the leg being flown.
 *
 * A landing on its own is not a boundary: the leg that ends with it is the one
 * whose approach the trail is there to show.
 */
export function lastContinuousRun<T extends TimedReport>(points: T[], gapMaxMs = LEG_RUN_GAP_MAX_MS): T[] {
  const inTime = [...points].sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
  let start = 0;
  for (let i = inTime.length - 1; i > 0; i--) {
    const prev = inTime[i - 1];
    const cur = inTime[i];
    const gap = Date.parse(cur.observedAt) - Date.parse(prev.observedAt);
    const tookOff = prev.onGround === true && cur.onGround === false;
    if (gap > gapMaxMs || tookOff) {
      start = i;
      break;
    }
  }
  return inTime.slice(start);
}
