import { expect, test } from "@playwright/test";
import { findMarkerNear, getRouteVertices, HISTORIES, LIVE_FIXTURE, mockFlightApi, renderedPlanes, setMapView, waitForMapReady, waitForPlanes } from "./helpers";

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

// Intermittent: the selected plane's trail ran ahead of its marker. The trail
// is the history's real reports; the marker is the estimated position the
// selection or the last poll gave. A history with a report newer than that
// position drew the trail past the marker until the next poll caught up.
test("the trail ends at the selected plane's marker, never past it", async ({ page }) => {
  await mockFlightApi(page);
  // The selected plane's own poll is down: the marker keeps the position it was selected at.
  await page.route("**/api/flights/4d00d9/live*", (route) => route.fulfill({ status: 404, json: null }));
  const history = HISTORIES["4d00d9"];
  const last = history[history.length - 1];
  const newer = { ...last, observedAt: new Date(Date.parse(last.observedAt) + 30_000).toISOString(), latitude: last.latitude - 0.03, longitude: last.longitude - 0.05 };
  await page.route("**/api/flights/4d00d9/history*", (route) => route.fulfill({ json: [...history, newer] }));
  await page.goto("/");
  await waitForMapReady(page);
  await setMapView(page, plane.latitude, plane.longitude, 11);
  await waitForPlanes(page);
  await (await findMarkerNear(page, plane.latitude, plane.longitude)).click();
  await page.getByText("ICAO24 4D00D9").waitFor({ timeout: 5_000 });

  await expect.poll(() => routeVertices(page).then((v) => v.length), { timeout: 5_000 }).toBeGreaterThan(10);
  // The selected marker is drawn on the next frame after the selection.
  await expect.poll(async () => (await renderedPlanes(page)).find((p) => p.selected)?.icao24, { timeout: 5_000 }).toBe("4d00d9");
  const marker = (await renderedPlanes(page)).find((p) => p.selected)!;
  const v = await routeVertices(page);
  const end = v[v.length - 1];
  expect(end.lat).toBeCloseTo(marker.lat, 3); // drawn positions are float32: ~10 m, against the 3 km the newer report is off
  expect(end.lon).toBeCloseTo(marker.lon, 3);
  expect(v.some((p) => Math.abs(p.lat - newer.latitude) < 1e-6)).toBe(false);
});
