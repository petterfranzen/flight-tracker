import { expect, test } from "@playwright/test";
import { findMarkerNear, getRouteVertices, LIVE_FIXTURE, mockFlightApi, setMapView, waitForMapReady, waitForPlanes } from "./helpers";

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
