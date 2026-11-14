import { expect, test } from "@playwright/test";
import { smoothRoute } from "../src/map/route";

// The trail is a Catmull-Rom spline through the real reports (map/route.ts).
// The uniform spline hooked outside the track at a sharp, unevenly spaced
// turn — the runway exit a plane taxies through — drawing a bulge where the
// aircraft never was. The smoothed trail must stay inside the box the
// reports themselves occupy.

type Point = [number, number];

function box(points: Point[]) {
  const lats = points.map((p) => p[0]);
  const lons = points.map((p) => p[1]);
  return { latMin: Math.min(...lats), latMax: Math.max(...lats), lonMin: Math.min(...lons), lonMax: Math.max(...lons) };
}

function withinBox(smoothed: Point[], points: Point[]): void {
  const b = box(points);
  for (const [lat, lon] of smoothed) {
    expect(lat, `lat ${lat} outside [${b.latMin}, ${b.latMax}]`).toBeGreaterThanOrEqual(b.latMin - 1e-9);
    expect(lat, `lat ${lat} outside [${b.latMin}, ${b.latMax}]`).toBeLessThanOrEqual(b.latMax + 1e-9);
    expect(lon, `lon ${lon} outside [${b.lonMin}, ${b.lonMax}]`).toBeGreaterThanOrEqual(b.lonMin - 1e-9);
    expect(lon, `lon ${lon} outside [${b.lonMin}, ${b.lonMax}]`).toBeLessThanOrEqual(b.lonMax + 1e-9);
  }
}

test.describe("smoothRoute", () => {
  test("a sharp, unevenly spaced turn does not overshoot the reports' box", () => {
    // North up the runway, a hard turn east onto the exit, then a long final
    // gap: the shape that made the uniform spline bulge past the corner.
    const trail: Point[] = [[0, 0], [0, 0.02], [0, 1], [0.05, 1.3], [1.3, 1.4]];
    withinBox(smoothRoute(trail), trail);
  });

  test("a plain 90° corner stays inside its reports' box", () => {
    const trail: Point[] = [[0, 0], [1, 0], [1, 1]];
    withinBox(smoothRoute(trail), trail);
  });

  test("a hard turn with a long approach stays inside the reports' box", () => {
    const trail: Point[] = [[0, 0], [10, 0], [10, 1], [10, 2]];
    withinBox(smoothRoute(trail), trail);
  });

  test("passes through every report, in order, and ends on the last one", () => {
    const trail: Point[] = [[0, 0], [0, 0.02], [0, 1], [0.05, 1.3], [1.3, 1.4]];
    const out = smoothRoute(trail);

    // One segment per gap, ROUTE_SPLINE_SEGMENTS points each, plus the final report.
    expect(out.length).toBe((trail.length - 1) * 8 + 1);
    expect(out[out.length - 1]).toEqual(trail[trail.length - 1]);
    for (const [lat, lon] of trail) {
      expect(out.some(([a, b]) => Math.abs(a - lat) < 1e-9 && Math.abs(b - lon) < 1e-9), `report (${lat}, ${lon}) missing from the spline`).toBe(true);
    }
    for (const [lat, lon] of out) {
      expect(Number.isFinite(lat) && Number.isFinite(lon), "the spline produced a non-finite point").toBe(true);
    }
  });

  test("below three points it returns them untouched", () => {
    expect(smoothRoute([[0, 0]])).toEqual([[0, 0]]);
    expect(smoothRoute([[0, 0], [1, 1]])).toEqual([[0, 0], [1, 1]]);
  });

  test("repeated reports (a plane parked at one spot) stay finite and inside the box", () => {
    const trail: Point[] = [[59.65, 17.93], [59.65, 17.93], [59.65, 17.93], [59.66, 17.94]];
    const out = smoothRoute(trail);
    withinBox(out, trail);
    for (const [lat, lon] of out) expect(Number.isFinite(lat) && Number.isFinite(lon)).toBe(true);
  });
});
