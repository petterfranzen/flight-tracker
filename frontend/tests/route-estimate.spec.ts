import { expect, test } from "@playwright/test";
import { findMarkerNear, getRouteVertices, LIVE_FIXTURE, mockFlightApi, renderedPlanes, setMapView, waitForMapReady, waitForPlanes, withMap } from "./helpers";

// The server dead-reckons an aircraft forward from its last real report and
// sends that estimate with the report's own observedAt. The trail must not
// absorb those estimates as if they were reports (reported: SAS2197's trail
// ran past the real track once zoomed out, where only the selected plane's
// poll arrives).
//
// Every endpoint serves the same estimate (LiveStateStore's display
// position), so the viewport's /live refresh, which fires on the same 72 s
// tick as the selected plane's poll, carries it too. Serving the raw report
// there instead made the tip vanish whenever that refresh landed last.

const plane = LIVE_FIXTURE.find((p) => p.icao24 === "4d00d9")!;

const routeVertices = (page: import("@playwright/test").Page) => getRouteVertices(page);

test("estimated positions move the end of the trail instead of piling up in it", async ({ page }) => {
  await page.clock.install(); // before the page starts its timers; time still flows until we jump it
  await mockFlightApi(page);
  let polls = 0;
  // Same observedAt as the last real report every time, further along each poll.
  const estimate = () => ({ ...plane, latitude: plane.latitude - 0.02 * polls, longitude: plane.longitude + 0.01 * polls });
  await page.route("**/api/flights/4d00d9/live*", (route) => {
    polls++;
    return route.fulfill({ json: estimate() });
  });
  await page.route(/\/api\/flights\/live\?/, (route) =>
    route.fulfill({ json: LIVE_FIXTURE.map((p) => (p.icao24 === plane.icao24 && polls > 0 ? estimate() : p)) }),
  );
  await page.goto("/");
  await waitForMapReady(page);
  await setMapView(page, plane.latitude, plane.longitude, 11);
  await waitForPlanes(page);
  await page.waitForTimeout(500);
  await (await findMarkerNear(page, plane.latitude, plane.longitude)).click();
  await page.getByText("ICAO24 4D00D9").waitFor({ timeout: 5_000 });
  // The history and the first poll land in either order: the baseline is
  // the trail once both are in, with the first estimate on its end.
  await expect.poll(() => routeVertices(page).then((v) => v.length > 10 && v[v.length - 1].lat === estimate().latitude), { timeout: 5_000 }).toBe(true);
  const afterFirst = (await routeVertices(page)).length;

  // More polls, each projecting the plane further.
  for (let i = 0; i < 3; i++) await page.clock.runFor(72_000);
  await expect.poll(() => polls, { timeout: 5_000 }).toBeGreaterThanOrEqual(3);
  // Drawn once that poll's response is handled, not when it is served.
  await expect.poll(() => routeVertices(page).then((v) => v[v.length - 1].lat), { timeout: 5_000 }).toBeCloseTo(estimate().latitude, 4);

  const v = await routeVertices(page);
  // 24 real reports + one tip: the same number of vertices however many estimates arrived.
  expect(v.length).toBe(afterFirst);
  const tip = v[v.length - 1];
  expect(tip.lat).toBeCloseTo(plane.latitude - 0.02 * polls, 4);
  // Earlier estimates are gone: only the latest one is in the trail.
  expect(v.filter((p) => Math.abs(p.lat - (plane.latitude - 0.02)) < 1e-6)).toHaveLength(0);
});

// Seen on SEKHU: the trail's newest point ahead of the marker. A live frame
// for the selected plane drew the map before it updated the selected
// position, so the trail took the new point and the marker stayed put.
test("a live frame moves the selected marker to the trail's newest point", async ({ page }) => {
  await mockFlightApi(page);
  await page.route("**/api/flights/4d00d9/live*", (route) => route.fulfill({ status: 404, json: null })); // only the frame moves it
  let feed: import("@playwright/test").WebSocketRoute | null = null;
  await page.routeWebSocket("**/ws/live", (ws) => {
    feed = ws;
  });
  await page.goto("/");
  await waitForMapReady(page);
  await setMapView(page, plane.latitude, plane.longitude, 11);
  await waitForPlanes(page);
  await (await findMarkerNear(page, plane.latitude, plane.longitude)).click();
  await page.getByText("ICAO24 4D00D9").waitFor({ timeout: 5_000 });
  await expect.poll(() => routeVertices(page).then((v) => v.length), { timeout: 5_000 }).toBeGreaterThan(10);

  // The first fresh position flies the map to the new selection (and that move redraws everything); the next only moves the plane.
  const first = { ...plane, observedAt: new Date(Date.now() - 5_000).toISOString() };
  feed!.send(JSON.stringify(first));
  await expect.poll(() => routeVertices(page).then((v) => v[v.length - 1].lat), { timeout: 5_000 }).toBeCloseTo(first.latitude, 3);
  await expect.poll(() => withMap(page, (map) => map.isMoving()), { timeout: 5_000 }).toBe(false);

  const next = { ...plane, observedAt: new Date(Date.now()).toISOString(), latitude: plane.latitude + 0.03, longitude: plane.longitude + 0.02 };
  feed!.send(JSON.stringify(next));

  // The selected plane's source, read the way getRouteVertices reads the trail's: the same moment, both sides.
  const selectedSource = () =>
    withMap(page, async (map) => {
      const source = map.gl.getSource("plane-selected") as { getData(): Promise<{ features: { geometry: { coordinates: [number, number] } }[] }> } | undefined;
      const f = source ? (await source.getData()).features[0] : undefined;
      return f ? { lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0] } : null;
    });
  // The frame updates both at once, so as soon as the trail has the new point the marker must be on it.
  await expect.poll(() => routeVertices(page).then((v) => v[v.length - 1].lat), { timeout: 5_000, intervals: [20] }).toBeCloseTo(next.latitude, 3);
  expect((await selectedSource())?.lat).toBeCloseTo(next.latitude, 6);
  expect((await selectedSource())?.lon).toBeCloseTo(next.longitude, 6);
  // And that is what is drawn.
  const selected = async () => (await renderedPlanes(page)).find((p) => p.selected);
  await expect.poll(async () => (await selected())?.lat, { timeout: 3_000 }).toBeCloseTo(next.latitude, 3);
});
