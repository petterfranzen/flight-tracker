// Pure, map-free: which planes get drawn when they would overlap on screen.
// The rule is "first discovered wins": of any planes whose icons overlap, only
// the one this map saw first is drawn and the others are hidden. First
// discovered is stable (a plane keeps its place in line for the whole
// session), so a plane doesn't swap with its neighbour on every update.

/** Two icons overlap when their centres are closer than this fraction of the icon's box size (the dart fills well under 70% of it, even rotated). */
export const OVERLAP_FRACTION = 0.7;

const ranks = new Map<string, number>();
let nextRank = 0;

/** Position in the order planes were first seen by this map (0 = first). Assigned on first ask. */
export function discoveryRank(icao24: string): number {
  let r = ranks.get(icao24);
  if (r === undefined) {
    r = nextRank++;
    ranks.set(icao24, r);
  }
  return r;
}

export interface Candidate {
  icao24: string;
  /** Screen position, px. */
  x: number;
  y: number;
  /** In the air and recently heard from (see isActiveTraffic): beats a parked or silent plane. */
  active: boolean;
}

/**
 * The icao24s to draw: candidates in priority order (active before inactive,
 * then discovery order), each kept only if its box doesn't overlap one
 * already kept or one of `fixed` (the selected plane, which is always
 * drawn). A grid with cells of the overlap distance means each candidate only
 * looks at nine cells, so this is linear in the number of candidates.
 *
 * `maxCount` bounds how many are kept (every marker is a DOM node, and a
 * zoom step re-places all of them). If more would be kept, the spacing is
 * widened and the pass repeated, so the thinning is even across the screen
 * (every area keeps its first-discovered planes, just further apart) rather
 * than the first `maxCount` planes in priority order clumping wherever they
 * happen to be.
 */
export function pickNonOverlapping(candidates: Candidate[], fixed: { x: number; y: number }[], boxPx: number, maxCount = Infinity): Set<string> {
  const order = candidates.map((c) => ({ c, rank: discoveryRank(c.icao24) }));
  order.sort((a, b) => (a.c.active === b.c.active ? a.rank - b.rank : a.c.active ? -1 : 1));

  let min = Math.max(1, boxPx * OVERLAP_FRACTION);
  let shown = pickOnce(order, fixed, min);
  // Area scales with spacing squared, so this lands close to the cap in one or two more passes.
  for (let pass = 0; shown.size > maxCount && pass < 6; pass++) {
    min *= Math.max(1.08, Math.sqrt(shown.size / maxCount));
    shown = pickOnce(order, fixed, min);
  }
  return shown;
}

function pickOnce(order: { c: Candidate }[], fixed: { x: number; y: number }[], min: number): Set<string> {
  const grid = new Map<number, { x: number; y: number }[]>();
  const key = (cx: number, cy: number): number => cx * 100_003 + cy;
  const add = (p: { x: number; y: number }): void => {
    const k = key(Math.floor(p.x / min), Math.floor(p.y / min));
    const bucket = grid.get(k);
    if (bucket) bucket.push(p);
    else grid.set(k, [p]);
  };
  const blocked = (p: { x: number; y: number }): boolean => {
    const cx = Math.floor(p.x / min);
    const cy = Math.floor(p.y / min);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const q of grid.get(key(cx + dx, cy + dy)) ?? []) {
          if (Math.abs(p.x - q.x) < min && Math.abs(p.y - q.y) < min) return true;
        }
      }
    }
    return false;
  };

  for (const f of fixed) add(f);
  const shown = new Set<string>();
  for (const { c } of order) {
    if (blocked(c)) continue;
    add(c);
    shown.add(c.icao24);
  }
  return shown;
}

const TILE_PX = 256;
const MIN_CELL_DEG = 0.5; // the server's floor (FlightController MIN_CLUSTER_GRID_DEG)
const MAX_CELL_DEG = 40;

/**
 * The cell size, in degrees, the server keeps one plane per: half an icon, so
 * a plane it drops would have been drawn under one it keeps.
 */
export function declutterCellDeg(zoom: number, boxPx: number): number {
  const degPerPx = 360 / (TILE_PX * Math.pow(2, zoom));
  return Math.min(MAX_CELL_DEG, Math.max(MIN_CELL_DEG, boxPx * 0.5 * degPerPx));
}
