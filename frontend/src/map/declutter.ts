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

/** A plane drawn last time is displaced by a higher-priority newcomer only when their centres are closer than this fraction of the spacing: on top of it, not merely near it. */
export const DISPLACE_FRACTION = 0.5;

/**
 * What a map remembers between renders so that panning doesn't reshuffle
 * which planes are drawn: the set drawn last time, and the spacing factor
 * the cap last needed.
 */
export interface DeclutterMemory {
  drawn: Set<string>;
  /** Multiplies the zoom's spacing; above 1 only while the cap needs it. */
  spacing: number;
}

export function newDeclutterMemory(): DeclutterMemory {
  return { drawn: new Set(), spacing: 1 };
}

/**
 * The icao24s to draw: candidates in priority order (active before inactive,
 * then discovery order), each kept only if its box doesn't overlap one
 * already kept or one of `fixed` (the selected plane, which is always
 * drawn). A grid with cells of the overlap distance means each candidate only
 * looks at nine cells, so this is linear in the number of candidates.
 *
 * The spacing comes from the zoom (`boxPx`), so it is the same all through a
 * pan. With `memory`, the planes drawn last time go first and keep their place
 * unless a higher-priority newcomer lands right on top of one
 * (DISPLACE_FRACTION). Without it a pan reshuffled the screen: a plane at the
 * edge entering or leaving the view freed or took a neighbour's spot, that
 * neighbour's neighbour flipped the other way, and so on across the map.
 *
 * `maxCount` bounds how many are kept (every render re-sends the drawn set to
 * the map). If more would be kept, the spacing is widened and the pass
 * repeated, so the thinning is even across the screen rather than the first
 * `maxCount` planes in priority order clumping wherever they happen to be.
 * The widened spacing is remembered and only drops back once the count is
 * well under the cap, so a pan through a dense area doesn't change it on
 * every frame.
 */
export function pickNonOverlapping(
  candidates: Candidate[],
  fixed: { x: number; y: number }[],
  boxPx: number,
  maxCount = Infinity,
  memory: DeclutterMemory = newDeclutterMemory(),
): Set<string> {
  const order = candidates.map((c) => ({ c, rank: discoveryRank(c.icao24), held: memory.drawn.has(c.icao24) }));
  order.sort((a, b) => (a.c.active === b.c.active ? a.rank - b.rank : a.c.active ? -1 : 1));

  const base = Math.max(1, boxPx * OVERLAP_FRACTION);
  let factor = memory.spacing;
  let shown = pickOnce(order, fixed, base * factor);
  if (factor > 1 && shown.size < maxCount / 2) {
    // Far under the cap now (zoomed in, or out of the dense area): back to the zoom's own spacing.
    factor = 1;
    shown = pickOnce(order, fixed, base);
  }
  // Area scales with spacing squared, so this lands close to the cap in one or two more passes.
  for (let pass = 0; shown.size > maxCount && pass < 6; pass++) {
    factor *= Math.max(1.08, Math.sqrt(shown.size / maxCount));
    shown = pickOnce(order, fixed, base * factor);
  }
  memory.spacing = factor;
  memory.drawn = shown;
  return shown;
}

interface Placed {
  x: number;
  y: number;
  /** Index in priority order; -1 for a fixed point. */
  at: number;
  held: boolean;
  icao24?: string;
  gone?: boolean;
}

function pickOnce(order: { c: Candidate; held: boolean }[], fixed: { x: number; y: number }[], min: number): Set<string> {
  const grid = new Map<number, Placed[]>();
  const key = (cx: number, cy: number): number => cx * 100_003 + cy;
  const add = (p: Placed): void => {
    const k = key(Math.floor(p.x / min), Math.floor(p.y / min));
    const bucket = grid.get(k);
    if (bucket) bucket.push(p);
    else grid.set(k, [p]);
  };
  const overlapping = (p: { x: number; y: number }): Placed[] => {
    const cx = Math.floor(p.x / min);
    const cy = Math.floor(p.y / min);
    const out: Placed[] = [];
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const q of grid.get(key(cx + dx, cy + dy)) ?? []) {
          if (!q.gone && Math.abs(p.x - q.x) < min && Math.abs(p.y - q.y) < min) out.push(q);
        }
      }
    }
    return out;
  };

  for (const f of fixed) add({ x: f.x, y: f.y, at: -1, held: true });
  const shown = new Set<string>();
  // Held planes (drawn last time) first, among themselves in priority order:
  // they only give way to the selected plane or to each other.
  order.forEach(({ c, held }, at) => {
    if (!held || overlapping(c).length > 0) return;
    add({ x: c.x, y: c.y, at, held: true, icao24: c.icao24 });
    shown.add(c.icao24);
  });
  // Then newcomers. One that ranks above a held plane takes its place only if it's right on top of it.
  const close = min * DISPLACE_FRACTION;
  order.forEach(({ c, held }, at) => {
    if (held) return;
    const hits = overlapping(c);
    const displaceable = hits.every((q) => q.held && q.at > at && Math.abs(c.x - q.x) < close && Math.abs(c.y - q.y) < close);
    if (!displaceable) return;
    for (const q of hits) {
      q.gone = true;
      shown.delete(q.icao24!);
    }
    add({ x: c.x, y: c.y, at, held: false, icao24: c.icao24 });
    shown.add(c.icao24);
  });
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
