import { observedAtMs } from "./reportOrder";

/**
 * Client-side glide between position reports (section9-hq#250).
 *
 * The live feed pushes one report per aircraft every few seconds. Between two
 * reports the drawn marker sits still, then jumps when the next one lands. The
 * glide moves it along the track its last two reports imply, at the speed those
 * reports imply, and stops a few seconds past the newest report rather than
 * guessing further into the future.
 *
 * Everything here is pure and map-free: `map/planes.ts` records the fixes, asks
 * for a point every tick, and re-sends the drawn set only when something moved.
 *
 * Off by default (`GLIDE_ENABLED`), on with `?glide=1` in the URL (a spec, or a
 * device that wants it). It re-sends the plane source as positions advance,
 * which is extra per-frame work the perf suite does not budget for, so the
 * default stays put until that budget is re-measured (see the PR).
 */

/** Master switch. */
export const GLIDE_ENABLED = false;

/** Whether the glide is on for this URL. */
export function glideRequested(search: string): boolean {
  return GLIDE_ENABLED || new URLSearchParams(search).get("glide") === "1";
}

/** Never extrapolate further than this past the newest report: stop, don't guess. */
export const GLIDE_MAX_MS = 5_000;

/** Implied ground speed outside this band is not a track worth gliding along (parked, or a bad pair). */
export const GLIDE_MIN_SPEED_MS = 10;
export const GLIDE_MAX_SPEED_MS = 400;

/** Two reports further apart than this are not "between fixes" any more: no glide. */
export const GLIDE_MAX_FIX_GAP_MS = 60_000;

/** One position report, as the glide needs it. */
export interface Fix {
  lat: number;
  lon: number;
  atMs: number;
}

/** The last two reports of one aircraft, oldest first. */
export interface Track {
  prev: Fix;
  cur: Fix;
  /** The newest report's own `observedAt`, so the same report recorded twice is a no-op. */
  observedAt: string;
}

const M_PER_DEG_LAT = 111_320;

function fixOf(p: { observedAt: string; latitude: number; longitude: number }): Fix {
  return { lat: p.latitude, lon: p.longitude, atMs: observedAtMs(p.observedAt) };
}

/** The ground speed the two fixes imply, m/s (0 when they share an instant). */
export function impliedSpeedMs(prev: Fix, cur: Fix): number {
  const dt = (cur.atMs - prev.atMs) / 1_000;
  if (dt <= 0) return 0;
  const cosLat = Math.cos((cur.lat * Math.PI) / 180);
  const dy = (cur.lat - prev.lat) * M_PER_DEG_LAT;
  const dx = (cur.lon - prev.lon) * M_PER_DEG_LAT * cosLat;
  return Math.hypot(dx, dy) / dt;
}

/**
 * Records a marker as a fix. The first sighting makes a one-fix track (nothing
 * to glide along yet); a strictly newer `observedAt` shifts it in; the same
 * report again, or an older one, changes nothing.
 */
export function recordFix(
  track: Track | undefined,
  p: { observedAt: string; latitude: number; longitude: number },
): Track {
  const fix = fixOf(p);
  if (!track) return { prev: fix, cur: fix, observedAt: p.observedAt };
  if (p.observedAt === track.observedAt) return track;
  if (!(fix.atMs > observedAtMs(track.observedAt))) return track;
  return { prev: track.cur, cur: fix, observedAt: p.observedAt };
}

/**
 * Where to draw the marker at `nowMs`: the newest fix projected forward along
 * the track the last two imply, with the projection clamped to `GLIDE_MAX_MS`
 * past the newest fix. Null means "leave it at the report's own position" —
 * no track yet, an implausible pair of fixes, or no time elapsed since the
 * newest one.
 */
export function glidePoint(track: Track | undefined, nowMs: number): { lat: number; lon: number } | null {
  if (!track) return null;
  const { prev, cur } = track;
  const elapsed = nowMs - cur.atMs;
  if (elapsed <= 0) return null;
  const dt = cur.atMs - prev.atMs;
  if (dt <= 0 || dt > GLIDE_MAX_FIX_GAP_MS) return null;
  const speed = impliedSpeedMs(prev, cur);
  if (speed < GLIDE_MIN_SPEED_MS || speed > GLIDE_MAX_SPEED_MS) return null;
  const f = Math.min(elapsed, GLIDE_MAX_MS) / dt;
  return { lat: cur.lat + (cur.lat - prev.lat) * f, lon: cur.lon + (cur.lon - prev.lon) * f };
}

/**
 * Whether this track still has glide to do at `nowMs` — true from the moment
 * the newest report lands (elapsed 0) until the clamp, false for a track that
 * cannot glide at all. The ticker keeps running while any drawn track is
 * pending and stops when none is, so a map with nothing to animate costs
 * nothing.
 */
export function glidePending(track: Track | undefined, nowMs: number): boolean {
  if (!track) return false;
  const { prev, cur } = track;
  const dt = cur.atMs - prev.atMs;
  if (dt <= 0 || dt > GLIDE_MAX_FIX_GAP_MS) return false;
  const speed = impliedSpeedMs(prev, cur);
  if (speed < GLIDE_MIN_SPEED_MS || speed > GLIDE_MAX_SPEED_MS) return false;
  return nowMs - cur.atMs < GLIDE_MAX_MS;
}

/** The direction the track runs in, in degrees; null when the two fixes coincide. */
function direction(track: Track | undefined): { lon: number; lat: number } | null {
  if (!track) return null;
  const lon = track.cur.lon - track.prev.lon;
  const lat = track.cur.lat - track.prev.lat;
  return lon === 0 && lat === 0 ? null : { lon, lat };
}

/**
 * The point to draw for an aircraft whose report sits at `base`: the glided
 * point, `base` itself, or `floor` (what was drawn last), whichever is furthest
 * along the track.
 *
 * The "furthest along" pick is the never-backwards rule. The glide runs ahead
 * of the reports; when the aircraft then reports a position behind where the
 * glide had already reached (it slowed, or the projection overshot), the drawn
 * marker holds still there until the real track catches up rather than jumping
 * backwards. A later report ahead of the drawn point moves it at once.
 */
export function glidedPoint(
  base: { lat: number; lon: number },
  track: Track | undefined,
  nowMs: number,
  floor: { lat: number; lon: number } | null,
): { lat: number; lon: number } {
  const dir = direction(track);
  if (!dir) return base;
  let best = base;
  let bestAlong = 0;
  for (const c of [glidePoint(track, nowMs), floor]) {
    if (!c) continue;
    const along = (c.lon - base.lon) * dir.lon + (c.lat - base.lat) * dir.lat;
    if (along > bestAlong) {
      bestAlong = along;
      best = c;
    }
  }
  return best;
}
