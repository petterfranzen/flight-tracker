import { expect, test } from "@playwright/test";
import { clusterCellKey, clusterPositions, gridDegForZoom } from "../src/map/clusterMath";
import type { LiveMarker } from "../src/types/flight";

// Pure functions: no browser involved. They mirror LiveStateStore.clustered
// (backend), which has its own tests; the two must agree.

const m = (icao24: string, latitude: number, longitude: number): LiveMarker => ({
  icao24,
  callsign: null,
  observedAt: "2026-01-01T00:00:00Z",
  latitude,
  longitude,
  headingDeg: null,
});

test.describe("cluster maths", () => {
  test("a cluster sits at the mean position of its aircraft, not its cell centre", () => {
    // Grid 2 deg: both in lat [10,12) x lon [20,22), centre (11, 21).
    const out = clusterPositions([m("a", 10.1, 20.1), m("b", 10.3, 20.5), m("c", 30.2, -40.7)], 2);
    expect(out).toHaveLength(2);
    const pair = out.find((c) => c.count === 2)!;
    expect(pair.lat).toBeCloseTo(10.2, 9);
    expect(pair.lon).toBeCloseTo(20.3, 9);
    const lone = out.find((c) => c.count === 1)!;
    expect(lone.lat).toBeCloseTo(30.2, 9);
    expect(lone.lon).toBeCloseTo(-40.7, 9);
  });

  test("counts and cell membership are unchanged by centroid placement", () => {
    const list = [m("a", 1, 1), m("b", 1.5, 1.2), m("c", 3.9, 1), m("d", -0.5, -0.5), m("e", -1.9, -1.9)];
    const out = clusterPositions(list, 2);
    expect(out.reduce((n, c) => n + c.count, 0)).toBe(list.length);
    // (1,1) and (1.5,1.2) share a cell, (3.9,1) is the next one up, the two negatives share another.
    expect(out.map((c) => c.count).sort()).toEqual([1, 2, 2]);
  });

  test("a cluster lies inside its own cell, including at the edges", () => {
    const out = clusterPositions([m("a", 10.0, 20.0), m("b", 11.99, 21.99)], 2);
    expect(out).toHaveLength(1);
    expect(out[0].lat).toBeGreaterThanOrEqual(10);
    expect(out[0].lat).toBeLessThan(12);
    expect(out[0].lon).toBeGreaterThanOrEqual(20);
    expect(out[0].lon).toBeLessThan(22);
  });

  test("the cell key is stable while the centroid drifts inside its cell, and differs per grid", () => {
    const grid = gridDegForZoom(5);
    const a = { lat: 51.2, lon: 4.1, count: 3 };
    const drifted = { lat: 51.2 + grid / 10, lon: 4.1 - grid / 10, count: 4 };
    expect(clusterCellKey(drifted, grid)).toBe(clusterCellKey(a, grid));
    expect(clusterCellKey(a, grid)).not.toBe(clusterCellKey(a, gridDegForZoom(6)));
    expect(clusterCellKey({ lat: 51.2 + 2 * grid, lon: 4.1, count: 1 }, grid)).not.toBe(clusterCellKey(a, grid));
  });
});
