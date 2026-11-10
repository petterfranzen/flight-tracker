import { expect, test, type Page } from "@playwright/test";
import { findMarkerNear, getRouteVertices, layerPaint, LIVE_FIXTURE, mockFlightApi, renderedRoute, setMapView, waitForMapReady, waitForPlanes } from "./helpers";

// #281: on a phone the selected plane's trail read as a broken line, because
// every trail was drawn with a line-dasharray. The flown path is now one solid
// accent line over a darker casing, and only a real gap in the reports (more
// than ~60 s or ~5 km between two of them) is drawn dashed — its own segment,
// with the solid line split there rather than splined across the hole.

// This box's software WebGL boots the map in 25-45 s (CLAUDE.md, "Writing
// tests that don't flake"): give every test here the same room.
test.setTimeout(120_000);

const plane = LIVE_FIXTURE.find((p) => p.icao24 === "4d00d9")!;

const iso = (ms: number) => new Date(ms).toISOString();

/** A report for the selected aircraft, at `plane`'s position plus an offset. */
function report(ms: number, dLat = 0, dLon = 0) {
  return {
    id: 1,
    icao24: plane.icao24,
    callsign: plane.callsign,
    observedAt: iso(ms),
    latitude: plane.latitude + dLat,
    longitude: plane.longitude + dLon,
    altitudeM: null,
    velocityMs: 100,
    headingDeg: 90,
    verticalRateMs: 0,
    onGround: false,
    agentSource: "opensky",
  };
}

async function selectPlane(page: Page): Promise<void> {
  await page.goto("/");
  await waitForMapReady(page, 30_000);
  await setMapView(page, plane.latitude, plane.longitude, 11);
  await waitForPlanes(page, 1, 30_000);
  await (await findMarkerNear(page, plane.latitude, plane.longitude)).click();
  await page.getByText("ICAO24 4D00D9").waitFor({ timeout: 5_000 });
}

test("the flown trail is one solid line, with a darker casing under it", async ({ page }) => {
  await mockFlightApi(page);
  await selectPlane(page);
  await expect.poll(async () => (await getRouteVertices(page)).length, { timeout: 10_000 }).toBeGreaterThan(0);

  const line = await layerPaint(page, "flight-route-line");
  expect(line["line-dasharray"], "the flown path is drawn solid, not dashed").toBeUndefined();
  expect(line["line-width"]).toBe(3);

  // The casing sits under the line: wider, and its own (darker) theme colour,
  // so a 3 px accent line still reads over the land.
  const casing = await layerPaint(page, "flight-route-casing");
  expect(Number(casing["line-width"])).toBeGreaterThan(3);
  expect(casing["line-color"]).not.toBe(line["line-color"]);

  // A dash meaning something still exists: the gap layer.
  const gap = await layerPaint(page, "flight-route-gap");
  expect(gap["line-dasharray"]).toBeTruthy();
});

test("a gap in the reports is drawn as its own dashed segment, not spliced across", async ({ page }) => {
  await mockFlightApi(page);
  const base = Date.parse(plane.observedAt);
  const history = [
    report(base - 1_250_000, 0.002, 0.002),
    report(base - 1_240_000, 0.001, 0.001),
    report(base - 1_230_000),
    // A 20-minute hole in the feed.
    report(base - 30_000, -0.001, 0.001),
    report(base - 20_000, -0.002, 0.002),
    report(base - 10_000, -0.003, 0.003),
  ];
  await page.route("**/api/flights/4d00d9/history*", (route) => route.fulfill({ json: history }));
  await selectPlane(page);

  await expect.poll(async () => (await renderedRoute(page)).gaps.length, { timeout: 10_000 }).toBe(1);
  const route = await renderedRoute(page);
  // Two solid runs: the line is split at the gap, not drawn through it.
  expect(route.trail).toHaveLength(2);
  // The dashed segment is exactly the missing leg, endpoint to endpoint.
  expect(route.gaps[0]).toEqual([
    [history[2].latitude, history[2].longitude],
    [history[3].latitude, history[3].longitude],
  ]);
  // The first run ends where the gap begins: nothing was splined across it.
  expect(route.trail[0][route.trail[0].length - 1]).toEqual([history[2].latitude, history[2].longitude]);
});

test("a tight run of reports is one solid line, with no gap segment", async ({ page }) => {
  await mockFlightApi(page);
  const base = Date.parse(plane.observedAt);
  const history = [0, 1, 2, 3, 4, 5].map((i) => report(base - (6 - i) * 10_000, -0.001 * i, 0.001 * i));
  await page.route("**/api/flights/4d00d9/history*", (route) => route.fulfill({ json: history }));
  await selectPlane(page);

  await expect.poll(async () => (await getRouteVertices(page)).length, { timeout: 10_000 }).toBeGreaterThan(0);
  const route = await renderedRoute(page);
  expect(route.gaps).toHaveLength(0);
  expect(route.trail).toHaveLength(1);
});
