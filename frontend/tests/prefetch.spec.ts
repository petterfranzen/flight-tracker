import { expect, test } from "@playwright/test";
import { freezeClock, mockFlightApi, overviewLevel, requestCentreLon, setMapView, trackRequests, waitForMapReady, withMap } from "./helpers";

// Once the view sits still, the overview for the zoom level either side is fetched in the
// background, so the next zoom step is drawn from cache with no request of its own.

const plane = { icao24: "ov0001", callsign: "OV1", observedAt: new Date().toISOString(), latitude: 59.3, longitude: 18.0, headingDeg: 90, onGround: false };

// Far from the opening view (Stockholm), so every request around it is the
// test's own, never one the opening view made or cached.
const MADRID = { lat: 40.4, lon: -3.7 };
const aroundMadrid = (url: string) => requestCentreLon(url) < 10;

test.describe("neighbour-zoom prefetch", () => {
  test("zooming one level out from a settled view makes no request of its own", async ({ page }) => {
    const overview = trackRequests(page, /\/api\/flights\/live\/overview/);
    const levels = (urls: string[]) => urls.filter(aroundMadrid).map((u) => overviewLevel(page, u));
    // A world summary under the opening-view threshold keeps the map on its default view.
    await mockFlightApi(page, { clusters: [{ lat: 59.5, lon: 18.5, count: 12 }], overviewPlanes: [plane] });
    await page.goto("/");
    await waitForMapReady(page);
    await setMapView(page, MADRID.lat, MADRID.lon, 6);
    // The view, then (600 ms after it lands) the zoom levels either side, all
    // landed: a zoom step before then would make its own request.
    await expect.poll(() => levels(overview.landed), { timeout: 10_000 }).toEqual(expect.arrayContaining([5, 6, 7]));
    await page.waitForTimeout(200); // the responses' cache writes
    const settled = overview.sent.length;

    // A request for the *next* level out (z4, the new neighbour) may follow;
    // none may be for the level now on screen.
    await setMapView(page, MADRID.lat, MADRID.lon, 5);
    await page.waitForTimeout(700); // past the viewport debounce
    expect(levels(overview.sent.slice(settled)), "zoom-out served from the prefetched level").not.toContain(5);
    const afterZoomOut = overview.sent.length;
    await setMapView(page, MADRID.lat, MADRID.lon, 6);
    await page.waitForTimeout(700);
    expect(levels(overview.sent.slice(afterZoomOut)), "and back again").not.toContain(6);
  });

  test("at the live zoom, the overview level below is prefetched (the zoom-out step)", async ({ page }) => {
    const overview = trackRequests(page, /\/api\/flights\/live\/overview/);
    await mockFlightApi(page, { clusters: [{ lat: 59.5, lon: 18.5, count: 12 }], overviewPlanes: [plane] });
    await page.goto("/");
    await waitForMapReady(page);
    await setMapView(page, MADRID.lat, MADRID.lon, 8); // zoom 8 uses /live; z7 is an overview level
    await expect.poll(() => overview.sent.filter(aroundMadrid).map((u) => overviewLevel(page, u)), { timeout: 5_000 }).toContain(7);
  });

  test("moving on cancels the pending prefetch: nothing fires while the new view is still loading", async ({ page }) => {
    const overview: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes("/api/flights/live/overview")) overview.push(r.url());
    });
    await mockFlightApi(page, { clusters: [{ lat: 59.5, lon: 18.5, count: 12 }], overviewPlanes: [plane] });
    // Each level's overview carries its own plane, to tell when one has been
    // applied. Requests around Madrid (the view moved to) are held until the
    // end: once a view's data lands, its own prefetch replaces any pending one,
    // so only a still-loading view shows whether the move cancelled it.
    let releaseMadrid: () => void = () => {};
    const madridHeld = new Promise<void>((resolve) => (releaseMadrid = resolve));
    await page.route("**/api/flights/live/overview*", async (route) => {
      const url = route.request().url();
      if (aroundMadrid(url)) await madridHeld;
      await route.fulfill({ json: { planes: [{ ...plane, icao24: `level${overviewLevel(page, url)}` }], clusters: [] } }).catch(() => {});
    });
    // The page's timers only run when the test says, so the prefetch is
    // certainly still pending when the map moves on, however busy the machine.
    await freezeClock(page);
    await page.goto("/");
    await waitForMapReady(page);
    await setMapView(page, 59.3, 18.0, 5);
    await page.clock.runFor(300); // past the viewport debounce: the view's own request
    // Applied (its plane is in the plane layer's data; nothing renders while
    // the clock stands still), so its prefetch (600 ms) is now pending.
    await expect
      .poll(() => withMap(page, (map) => JSON.stringify((map.gl.getSource("planes") as unknown as { serialize(): { data: unknown } } | undefined)?.serialize().data ?? null).includes('"level5"')), { timeout: 5_000 })
      .toBe(true);
    const during = overview.length;
    await setMapView(page, MADRID.lat, MADRID.lon, 5); // somewhere else before it fires
    await page.clock.runFor(1_000); // well past when the old prefetch was due
    await expect.poll(() => overview.length, { timeout: 5_000, message: "the new view was requested" }).toBeGreaterThan(during);
    expect(overview.slice(during).map((u) => overviewLevel(page, u)), "only the new view's own request").toEqual([5]);
    releaseMadrid();
  });
});
