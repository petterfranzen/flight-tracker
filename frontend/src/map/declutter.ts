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
 * which planes are drawn: which source, zoom level and cap the spacing was
 * worked out for, that spacing, and the set drawn last time.
 */
export interface DeclutterMemory {
  /** The source, zoom level and cap `spacing` was worked out for: `<source>:<rounded zoom>:<maxCount>`. */
  key: string;
  /** Multiplies the zoom's spacing; above 1 only while the cap needs it. */
  spacing: number;
  drawn: Set<string>;
}

export function newDeclutterMemory(): DeclutterMemory {
  return { key: "", spacing: 1, drawn: new Set() };
}

/**
 * The whole zoom level a spacing is worked out for. The map zooms
 * fractionally, and the box the spacing is measured in (`boxPx`) comes from a
 * whole level too, so the two can never disagree: a pinch inside one level
 * changes neither the box nor the key, and the stored widening is not left
 * stale against a box that moved under it.
 */
export function spacingLevel(zoom: number): number {
  return Math.round(zoom);
}

/**
 * What `memory.spacing` is stored under: which source, the whole zoom level
 * and the cap. The source is in it because the 7.5-8.0 band draws the overview
 * but rounds to level 8 — the same level the live source at 8.0 and up uses —
 * so without it, crossing the source switch there would keep the spacing the
 * other source worked out.
 */
export function spacingKey(source: string, zoom: number, maxCount: number): string {
  return `${source}:${spacingLevel(zoom)}:${maxCount}`;
}

/**
 * The icao24s to draw: candidates in priority order (active before inactive,
 * then discovery order), each kept only if its box doesn't overlap one
 * already kept or one of `fixed` (the selected plane, which is always
 * drawn). A grid with cells of the overlap distance means each candidate only
 * looks at nine cells, so this is linear in the number of candidates.
 *
 * With `memory` (one per map; `key` is the source, the zoom level and the cap) a pan
 * doesn't reshuffle the screen:
 * - The spacing belongs to the zoom level and cap: worked out afresh when
 *   `key` changes, then kept. More or fewer candidates at the edges no longer
 *   re-space every plane on screen.
 * - Planes drawn last time (held) keep their own spacing. When a pan pushes
 *   the count over `maxCount`, only the newcomers are spaced further apart —
 *   never the planes already on screen. Only a true overlap (or a
 *   higher-priority plane right on top of a held one, DISPLACE_FRACTION)
 *   hides a drawn plane.
 */
export function pickNonOverlapping(
  candidates: Candidate[],
  fixed: { x: number; y: number }[],
  boxPx: number,
  maxCount = Infinity,
  memory: DeclutterMemory = newDeclutterMemory(),
  key = "",
): Set<string> {
  const order = candidates.map((c) => ({ c, rank: discoveryRank(c.icao24), held: memory.drawn.has(c.icao24) }));
  order.sort((a, b) => (a.c.active === b.c.active ? a.rank - b.rank : a.c.active ? -1 : 1));

  const base = Math.max(1, boxPx * OVERLAP_FRACTION);

  if (memory.key !== key) {
    // A new zoom level or cap: the spacing starts over, thinned evenly across
    // the screen (area scales with spacing squared, so this lands close to the
    // cap in one or two more passes).
    let factor = 1;
    let shown = pickOnce(order, fixed, base);
    for (let pass = 0; shown.size > maxCount && pass < 6; pass++) {
      factor *= Math.max(1.08, Math.sqrt(shown.size / maxCount));
      shown = pickOnce(order, fixed, base * factor);
    }
    memory.key = key;
    memory.spacing = factor;
    memory.drawn = shown;
    return shown;
  }

  // The same zoom level and cap: the planes drawn last time keep the spacing
  // they had, and the newcomers (which have no place to keep yet) fill the room
  // between them, spaced further apart only as far as the cap needs. This is
  // what stops a pan into denser traffic from dropping planes all over the map.
  //
  // Few of them are still on screen — a pan out of a dense area, or most of the
  // drawn planes leaving the view - so the widening was for a density that is
  // gone: relax it back to the zoom's own spacing. Nothing already drawn drops,
  // because the held planes were laid out at least the wide spacing apart and
  // so are still clear of each other at the narrower one; only the room the
  // widening held open fills in. (Relaxed only, never re-widened, so it cannot
  // start changing the spacing on every frame again.)
  let heldCount = 0;
  for (const o of order) if (o.held) heldCount++;
  if (memory.spacing > 1 && heldCount * 2 < maxCount) memory.spacing = 1;

  const heldMin = base * memory.spacing;
  let newMin = heldMin;
  const spacing = (held: boolean): number => (held ? heldMin : newMin);
  let shown = pickOnce(order, fixed, heldMin, spacing);
  for (let pass = 0; shown.size > maxCount && pass < 6; pass++) {
    newMin *= Math.max(1.08, Math.sqrt(shown.size / maxCount));
    shown = pickOnce(order, fixed, heldMin, spacing);
  }
  // Widen the newcomers only so far: if the held planes alone fill the cap,
  // drop the lowest-priority newcomers rather than a plane already on screen.
  if (shown.size > maxCount) shown = dropNewcomers(order, shown, maxCount);
  memory.drawn = shown;
  return shown;
}

/** Over the cap at the widest spacing that still leaves room for the held planes: drop the lowest-priority newcomers, never a plane already drawn. */
function dropNewcomers(order: { c: Candidate; held: boolean }[], shown: Set<string>, maxCount: number): Set<string> {
  const out = new Set(shown);
  for (let i = order.length - 1; i >= 0 && out.size > maxCount; i--) {
    const o = order[i];
    if (!o.held && out.has(o.c.icao24)) out.delete(o.c.icao24);
  }
  return out;
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

/**
 * One pass in `order`. `spacing(held)` is how far a candidate must be from
 * everything kept before it; the grid is sized by the widest spacing in play,
 * so a candidate only looks at the nine cells around it.
 */
function pickOnce(order: { c: Candidate; held: boolean }[], fixed: { x: number; y: number }[], min: number, spacing: (held: boolean) => number = () => min): Set<string> {
  let cell = min;
  for (const o of order) cell = Math.max(cell, spacing(o.held));
  // The grid is a flat array indexed by (cell x, cell y), offset by the run's
  // own minimum cell: the screen coords of one render are a small rectangle, so
  // this is one allocation and an array index per lookup, where a Map keyed by
  // integers cost a hash per lookup. At 2,000 candidates over every pass of a
  // zoom that was the largest single cost inside renderAircraftLayer.
  let minCx = Infinity;
  let minCy = Infinity;
  let maxCx = -Infinity;
  let maxCy = -Infinity;
  for (const o of order) {
    const cx = Math.floor(o.c.x / cell);
    const cy = Math.floor(o.c.y / cell);
    if (cx < minCx) minCx = cx;
    if (cx > maxCx) maxCx = cx;
    if (cy < minCy) minCy = cy;
    if (cy > maxCy) maxCy = cy;
  }
  for (const f of fixed) {
    const cx = Math.floor(f.x / cell);
    const cy = Math.floor(f.y / cell);
    if (cx < minCx) minCx = cx;
    if (cx > maxCx) maxCx = cx;
    if (cy < minCy) minCy = cy;
    if (cy > maxCy) maxCy = cy;
  }
  if (minCx > maxCx) return new Set(); // no candidates and no fixed points
  // One cell of padding each side, so the nine-cell scan never leaves the array.
  const stride = maxCx - minCx + 3;
  const cells: (Placed[] | undefined)[] = new Array<Placed[] | undefined>((maxCy - minCy + 3) * stride);
  const at = (cx: number, cy: number): number => (cy - minCy + 1) * stride + (cx - minCx + 1);
  const add = (p: Placed): void => {
    const i = at(Math.floor(p.x / cell), Math.floor(p.y / cell));
    const bucket = cells[i];
    if (bucket) bucket.push(p);
    else cells[i] = [p];
  };
  // Reused by collect(): the newcomer pass needs the hits to decide whether
  // to displace them, but allocating an array per candidate was most of the
  // declutter pass's cost at 2,000+ planes. The held pass only needs a yes/no.
  const hits: Placed[] = [];
  const overlaps = (p: { x: number; y: number }, d: number): boolean => {
    const cx = Math.floor(p.x / cell);
    const cy = Math.floor(p.y / cell);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const bucket = cells[at(cx + dx, cy + dy)];
        if (!bucket) continue;
        for (const q of bucket) {
          if (q.gone) continue;
          if (Math.abs(p.x - q.x) < d && Math.abs(p.y - q.y) < d) return true;
        }
      }
    }
    return false;
  };
  const collect = (p: { x: number; y: number }, d: number): Placed[] => {
    hits.length = 0;
    const cx = Math.floor(p.x / cell);
    const cy = Math.floor(p.y / cell);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const bucket = cells[at(cx + dx, cy + dy)];
        if (!bucket) continue;
        for (const q of bucket) {
          if (!q.gone && Math.abs(p.x - q.x) < d && Math.abs(p.y - q.y) < d) hits.push(q);
        }
      }
    }
    return hits;
  };

  for (const f of fixed) add({ x: f.x, y: f.y, at: -1, held: true });
  const shown = new Set<string>();
  // Held planes (drawn last time) first, among themselves in priority order:
  // they only give way to the selected plane or to each other.
  const heldD = spacing(true);
  order.forEach(({ c, held }, at) => {
    if (!held || overlaps(c, heldD)) return;
    add({ x: c.x, y: c.y, at, held: true, icao24: c.icao24 });
    shown.add(c.icao24);
  });
  // Then newcomers. One that ranks above a held plane takes its place only if it's right on top of it.
  order.forEach(({ c, held }, at) => {
    if (held) return;
    const d = spacing(false);
    const close = heldD * DISPLACE_FRACTION; // against the held plane's spacing, not the widened newcomer one
    const hits = collect(c, d);
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
