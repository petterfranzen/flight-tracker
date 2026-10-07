import { expect, test } from "@playwright/test";
import { mockFlightApi, renderedPlanes, setMapView, waitForPlanes, withMap } from "./helpers";

// main.ts's view cache (map/viewCache.ts): going back to a view the map has
// just shown draws from memory, without a request and without fading the
// whole layer in again.

test.describe("view cache", () => {
  test("returning to a zoom level just seen makes no new overview request", async ({ page }) => {
    // A summary under the opening-view threshold keeps the map on its default view.
    await mockFlightApi(page, { clusters: [{ lat: 59.5, lon: 18.5, count: 12 }], overviewPlanes: [{ icao24: "ov0001", callsign: "OV1", observedAt: new Date().toISOString(), latitude: 59.3, longitude: 18.0, headingDeg: 90, onGround: false }] });
    const clusterRequests: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes("/api/flights/live/overview")) clusterRequests.push(r.url());
    });
    await page.goto("/");
    await page.waitForSelector(".map-container", { timeout: 10_000 });
    await setMapView(page, 59.3, 18.0, 6);
    await page.waitForTimeout(600);
    const afterFirstVisit = clusterRequests.length;

    await setMapView(page, 59.3, 18.0, 5);
    await page.waitForTimeout(600);
    // z5 was either fetched now or already prefetched in the background (see prefetch.spec.ts).
    expect(clusterRequests.length).toBeGreaterThanOrEqual(afterFirstVisit);
    const afterSecondVisit = clusterRequests.length;

    await waitForPlanes(page);
    const before = (await renderedPlanes(page)).find((p) => p.icao24 === "ov0001")!;
    await setMapView(page, 59.3, 18.0, 6);
    // Drawn straight from the cache — already there before the debounce
    // would even have fired a request (250 ms; the map draws a frame or two
    // after its data is set), and the same plane, drawn without a break
    // since before (not removed and re-added, so no fade-in on the way back).
    await expect
      .poll(async () => (await renderedPlanes(page)).find((p) => p.icao24 === "ov0001")?.drawnSince, { timeout: 200, intervals: [10] })
      .toBe(before.drawnSince);
    // Past the viewport debounce (250 ms) but before the background prefetch (600 ms after settling).
    await page.waitForTimeout(500);
    expect(clusterRequests.length).toBe(afterSecondVisit);
  });

  test("zooming in to the /live zoom reuses the parent view's aircraft", async ({ page }) => {
    await mockFlightApi(page);
    const liveRequests: string[] = [];
    page.on("request", (r) => {
      if (/\/api\/flights\/live\?/.test(r.url())) liveRequests.push(r.url());
    });
    await page.goto("/");
    await page.waitForSelector(".map-container");
    await setMapView(page, 59.65, 17.9, 8);
    await waitForPlanes(page);
    await page.waitForTimeout(600);
    expect(liveRequests).toHaveLength(1);

    // z9 at the same centre lies inside the z8 view: no request.
    await withMap(page, (map) => {
      map.setZoom(9, { animate: false });
    });
    await page.waitForTimeout(600);
    expect(liveRequests).toHaveLength(1);
  });
});
