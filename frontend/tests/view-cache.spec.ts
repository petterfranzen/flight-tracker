import { expect, test } from "@playwright/test";
import { mockFlightApi, overviewLevel, renderedPlanes, requestCentreLon, setMapView, trackRequests, waitForMapReady, waitForPlanes, withMap } from "./helpers";

// main.ts's view cache (map/viewCache.ts): going back to a view the map has
// just shown draws from memory, without a request and without fading the
// whole layer in again.

test.describe("view cache", () => {
  test("returning to a zoom level just seen makes no new overview request", async ({ page }) => {
    // Madrid: far from the opening view (Stockholm), so every request around it
    // is this test's own. A summary under the opening-view threshold keeps the
    // map on its default view until then.
    const MADRID = { lat: 40.4, lon: -3.7 };
    await mockFlightApi(page, { clusters: [{ lat: 59.5, lon: 18.5, count: 12 }], overviewPlanes: [{ icao24: "ov0001", callsign: "OV1", observedAt: new Date().toISOString(), latitude: MADRID.lat, longitude: MADRID.lon, headingDeg: 90, onGround: false }] });
    const overview = trackRequests(page, /\/api\/flights\/live\/overview/);
    const levels = (urls: string[]) => urls.filter((u) => requestCentreLon(u) < 10).map((u) => overviewLevel(page, u));
    await page.goto("/");
    await waitForMapReady(page);
    await setMapView(page, MADRID.lat, MADRID.lon, 6);
    await expect.poll(() => levels(overview.landed), { timeout: 5_000 }).toContain(6); // landed and cached

    await setMapView(page, MADRID.lat, MADRID.lon, 5);
    // z5 was either fetched now or already prefetched in the background (see prefetch.spec.ts).
    await expect.poll(() => levels(overview.landed), { timeout: 5_000 }).toContain(5);
    await waitForPlanes(page);
    const afterSecondVisit = overview.sent.length;

    const before = (await renderedPlanes(page)).find((p) => p.icao24 === "ov0001")!;
    await setMapView(page, MADRID.lat, MADRID.lon, 6);
    // The same plane, drawn without a break since before (not removed and
    // re-added, so no fade-in on the way back).
    await expect
      .poll(async () => (await renderedPlanes(page)).find((p) => p.icao24 === "ov0001")?.drawnSince, { timeout: 2_000, intervals: [10] })
      .toBe(before.drawnSince);
    // Past the viewport debounce (250 ms). The background prefetch may ask for
    // the levels either side; nothing may ask for the one drawn from the cache.
    await page.waitForTimeout(700);
    expect(levels(overview.sent.slice(afterSecondVisit)), "z6 drawn from the cache").not.toContain(6);
  });

  test("zooming in to the /live zoom reuses the parent view's aircraft", async ({ page }) => {
    await mockFlightApi(page);
    const live = trackRequests(page, /\/api\/flights\/live\?/);
    await page.goto("/");
    await waitForMapReady(page);
    await setMapView(page, 59.65, 17.9, 8);
    await waitForPlanes(page);
    await live.settled();
    expect(live.sent).toHaveLength(1);

    // z9 at the same centre lies inside the z8 view: no request.
    await withMap(page, (map) => {
      map.setZoom(9, { animate: false });
    });
    await page.waitForTimeout(700); // past the viewport debounce (250 ms)
    expect(live.sent).toHaveLength(1);
  });
});
