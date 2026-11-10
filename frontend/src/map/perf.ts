// Test seam: cheap, always-on counters for the plane layer's render cost.
// main.ts times renderAircraftLayer and its declutter pass; planes.ts counts
// setData calls. Reading them from a Playwright test (window.__flightPerf) is
// how docs/perf/PROFILE-2026-11-planes.md gets its numbers, and how the perf
// spec checks that setData only fires when the drawn set changed.
//
// The overhead is one performance.now() pair per render and one increment per
// setData: negligible next to the work being measured, so it stays in the
// production build rather than behind a dev-only branch.

export interface RenderStats {
  /** Milliseconds and calls for renderAircraftLayer. */
  render: { calls: number; totalMs: number; lastMs: number; maxMs: number };
  /** Milliseconds and calls for the pickNonOverlapping pass inside it. */
  declutter: { calls: number; totalMs: number; lastMs: number; maxMs: number };
  /** GeoJSON setData calls on the planes source and the selected-plane source. */
  setData: { planes: number; selected: number };
  /** Where the time inside renderAircraftLayer went, ms. */
  parts: { shadowed: number; project: number; declutter: number; update: number; filter: number };
  /** Milliseconds and moved-batch calls for the optional glide ticker (map/glide.ts), off by default. */
  glide: { calls: number; totalMs: number; lastMs: number; maxMs: number };
}

export const perf: RenderStats = {
  render: { calls: 0, totalMs: 0, lastMs: 0, maxMs: 0 },
  declutter: { calls: 0, totalMs: 0, lastMs: 0, maxMs: 0 },
  setData: { planes: 0, selected: 0 },
  parts: { shadowed: 0, project: 0, declutter: 0, update: 0, filter: 0 },
  glide: { calls: 0, totalMs: 0, lastMs: 0, maxMs: 0 },
};

export function resetPerf(): void {
  perf.render = { calls: 0, totalMs: 0, lastMs: 0, maxMs: 0 };
  perf.declutter = { calls: 0, totalMs: 0, lastMs: 0, maxMs: 0 };
  perf.setData = { planes: 0, selected: 0 };
  perf.parts = { shadowed: 0, project: 0, declutter: 0, update: 0, filter: 0 };
  perf.glide = { calls: 0, totalMs: 0, lastMs: 0, maxMs: 0 };
}

declare global {
  interface Window {
    __flightPerf?: RenderStats;
    __flightPerfReset?: () => void;
  }
}
