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
 *
 * With `memory` (one per map, `key` the zoom level and cap) a pan doesn't
 * reshuffle the screen:
 * - The spacing belongs to the zoom level: worked out afresh when `key`
 *   changes, then kept. More or fewer candidates at the edges no longer
 *   re-space every plane on screen.
 * - Planes drawn last time keep their place. Newcomers fill the room between
 *   them, and if the cap would be passed only the newcomers are spaced
 *   further apart. Only a true overlap (the base spacing, in normal priority
 *   order: active first, then first discovered) hides a drawn plane.
 */
export function pickNonOverlapping(
  candidates: Candidate[],
  fixed: { x: number; y: number }[],
  boxPx: number,
  maxCount = Infinity,
  memory?: DeclutterMemory,
  key = "",
): Set<string> {
  const order = candidates.map((c) => ({ c, rank: discoveryRank(c.icao24) }));
  order.sort((a, b) => (a.c.active === b.c.active ? a.rank - b.rank : a.c.active ? -1 : 1));

  const base = Math.max(1, boxPx * OVERLAP_FRACTION);
  if (!memory) return widen(order, fixed, base, 1, maxCount).shown;

  const free = pickOnce(order, fixed, base); // true overlaps are settled by priority alone
  const inPlay = order.filter((o) => free.has(o.c.icao24));
  if (memory.key !== key) {
    // A new zoom level: space everything afresh, as without memory.
    const { shown, factor } = widen(inPlay, fixed, base, 1, maxCount);
    Object.assign(memory, { key, factor, shown });
    return shown;
  }
  // The same zoom: what was drawn keeps its spacing, and newcomers fill the
  // room between, spaced further apart (only from here on) if the cap needs it.
  const prev = memory.shown;
  inPlay.sort((a, b) => Number(prev.has(b.c.icao24)) - Number(prev.has(a.c.icao24))); // stable: priority order within each group
  const keptMin = base * memory.factor;
  let newMin = keptMin;
  let shown = pickOnce(inPlay, fixed, keptMin, (c) => (prev.has(c.icao24) ? keptMin : newMin));
  for (let pass = 0; shown.size > maxCount && pass < 6; pass++) {
    newMin *= Math.max(1.08, Math.sqrt(shown.size / maxCount));
    shown = pickOnce(inPlay, fixed, newMin, (c) => (prev.has(c.icao24) ? keptMin : newMin));
  }
  memory.shown = shown;
  return shown;
}

/** What `pickNonOverlapping` remembers between renders. */
export interface DeclutterMemory {
  key: string;
  /** Spacing over the base overlap distance. */
  factor: number;
  shown: Set<string>;
}

/** Picks at `base * factor`, widening until at most `maxCount` are kept. */
function widen(order: { c: Candidate }[], fixed: { x: number; y: number }[], base: number, factor: number, maxCount: number): { shown: Set<string>; factor: number } {
  let shown = pickOnce(order, fixed, base * factor);
  // Area scales with spacing squared, so this lands close to the cap in one or two more passes.
  for (let pass = 0; shown.size > maxCount && pass < 6; pass++) {
    factor *= Math.max(1.08, Math.sqrt(shown.size / maxCount));
    shown = pickOnce(order, fixed, base * factor);
  }
  return { shown, factor };
}

/**
 * One pass in `order`. `spacing(c)` is how far a candidate must be from
 * everything kept before it (default `min`), never more than `min`, which
 * sizes the grid.
 */
function pickOnce(order: { c: Candidate }[], fixed: { x: number; y: number }[], min: number, spacing: (c: Candidate) => number = () => min): Set<string> {
  const grid = new Map<number, { x: number; y: number }[]>();
  const key = (cx: number, cy: number): number => cx * 100_003 + cy;
  const add = (p: { x: number; y: number }): void => {
    const k = key(Math.floor(p.x / min), Math.floor(p.y / min));
    const bucket = grid.get(k);
    if (bucket) bucket.push(p);
    else grid.set(k, [p]);
  };
  const blocked = (p: { x: number; y: number }, d: number): boolean => {
    const cx = Math.floor(p.x / min);
    const cy = Math.floor(p.y / min);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const q of grid.get(key(cx + dx, cy + dy)) ?? []) {
          if (Math.abs(p.x - q.x) < d && Math.abs(p.y - q.y) < d) return true;
        }
      }
    }
    return false;
  };

  for (const f of fixed) add(f);
  const shown = new Set<string>();
  for (const { c } of order) {
    if (blocked(c, spacing(c))) continue;
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
