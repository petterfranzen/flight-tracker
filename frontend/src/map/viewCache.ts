import type { Bounds } from "../types/flight";

/**
 * What the map has already fetched, so going back to a view (zooming out
 * again, panning back) draws instantly from memory instead of waiting on a
 * request and then re-creating every marker. Small and short-lived on
 * purpose: entries are only reused while they still roughly reflect live
 * traffic (see main.ts for the fresh/usable thresholds), and the map
 * revalidates anything older in the background.
 */
export interface CachedView<T> {
  zoom: number;
  bbox: Bounds;
  data: T;
  fetchedAt: number;
}

export function contains(outer: Bounds, inner: Bounds): boolean {
  return outer.latMin <= inner.latMin && outer.latMax >= inner.latMax && outer.lonMin <= inner.lonMin && outer.lonMax >= inner.lonMax;
}

/**
 * Expands `b` outward to multiples of `step` degrees (clamped to the valid
 * range). For cluster requests `step` is a multiple of the grid size, so
 * every returned cell is complete — an edge cell is never a partial count
 * of just the aircraft that happened to be inside the viewport — and
 * nearby viewports at the same zoom share one request.
 */
export function snapBounds(b: Bounds, step: number): Bounds {
  const down = (v: number) => Math.floor(v / step) * step;
  const up = (v: number) => Math.ceil(v / step) * step;
  return {
    latMin: Math.max(-90, down(b.latMin)),
    latMax: Math.min(90, up(b.latMax)),
    lonMin: Math.max(-180, down(b.lonMin)),
    lonMax: Math.min(180, up(b.lonMax)),
  };
}

export class ViewCache<T> {
  private entries: CachedView<T>[] = [];

  constructor(
    private readonly maxEntries: number,
    private readonly maxAgeMs: number,
  ) {}

  /** Newest usable entry whose bbox covers `view` at a zoom `zoomMatches` accepts. */
  find(view: Bounds, zoomMatches: (zoom: number) => boolean, now: number): CachedView<T> | null {
    let best: CachedView<T> | null = null;
    for (const e of this.entries) {
      if (now - e.fetchedAt > this.maxAgeMs || !zoomMatches(e.zoom) || !contains(e.bbox, view)) continue;
      if (!best || e.fetchedAt > best.fetchedAt) best = e;
    }
    return best;
  }

  put(entry: CachedView<T>): void {
    // Anything the new entry fully covers at the same zoom is now redundant.
    this.entries = this.entries.filter((e) => !(e.zoom === entry.zoom && contains(entry.bbox, e.bbox)));
    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) {
      this.entries.sort((a, b) => a.fetchedAt - b.fetchedAt);
      this.entries.splice(0, this.entries.length - this.maxEntries);
    }
  }

  get size(): number {
    return this.entries.length;
  }
}
