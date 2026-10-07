import { expect, test } from "@playwright/test";
import { mockFlightApi, setMapView } from "./helpers";

// Once the view sits still, the overview for the zoom level either side is fetched in the
// background, so the next zoom step is drawn from cache with no request of its own.

const plane = { icao24: "ov0001", callsign: "OV1", observedAt: new Date().toISOString(), latitude: 59.3, longitude: 18.0, headingDeg: 90, onGround: false };

test.describe("neighbour-zoom prefetch", () => {
  test("zooming one level out from a settled view makes no request of its own", async ({ page }) => {
    const overview: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes("/api/flights/live/overview")) overview.push(r.url());
    });
    // A world summary under the opening-view threshold keeps the map on its default view.
    await mockFlightApi(page, { clusters: [{ lat: 59.5, lon: 18.5, count: 12 }], overviewPlanes: [plane] });
    await page.goto("/");
    await page.waitForSelector(".map-container", { timeout: 10_000 });
    await setMapView(page, 59.3, 18.0, 6);
    await page.waitForTimeout(1_800); // settle + the prefetch delay + its requests
    const settled = overview.length;
    expect(settled, "the view plus the zoom levels either side").toBeGreaterThanOrEqual(3);
    // Which zoom level a request is for, from its width: a viewport-wide
    // bbox (snapped outwards a little) at 256 px per 360° at zoom 0.
    const width = page.viewportSize()!.width;
    const levelOf = (url: string) => {
      const q = new URL(url).searchParams;
      return Math.round(Math.log2(((width / 256) * 360) / (Number(q.get("lonMax")) - Number(q.get("lonMin")))));
    };
    expect(overview.map(levelOf)).toEqual(expect.arrayContaining([5, 6, 7]));

    // A request for the *next* level out (z4, the new neighbour) may follow;
    // none may be for the level now on screen.
    await setMapView(page, 59.3, 18.0, 5);
    await page.waitForTimeout(700); // past the viewport debounce
    expect(overview.slice(settled).map(levelOf), "zoom-out served from the prefetched level").not.toContain(5);
    const afterZoomOut = overview.length;
    await setMapView(page, 59.3, 18.0, 6);
    await page.waitForTimeout(700);
    expect(overview.slice(afterZoomOut).map(levelOf), "and back again").not.toContain(6);
  });

  test("at the live zoom, the overview level below is prefetched (the zoom-out step)", async ({ page }) => {
    const overview: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes("/api/flights/live/overview")) overview.push(r.url());
    });
    await mockFlightApi(page, { clusters: [{ lat: 59.5, lon: 18.5, count: 12 }], overviewPlanes: [plane] });
    await page.goto("/");
    await page.waitForSelector(".map-container", { timeout: 10_000 });
    await page.waitForTimeout(1_500);
    const before = overview.length;
    await setMapView(page, 59.3, 18.0, 8); // zoom 8 uses /live; z7 is an overview level
    await page.waitForTimeout(1_800);
    expect(overview.length).toBeGreaterThan(before);
  });

  test("moving on cancels the pending prefetch: no requests for a view that is gone", async ({ page }) => {
    const overview: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes("/api/flights/live/overview")) overview.push(r.url());
    });
    await mockFlightApi(page, { clusters: [{ lat: 59.5, lon: 18.5, count: 12 }], overviewPlanes: [plane] });
    await page.goto("/");
    await page.waitForSelector(".map-container", { timeout: 10_000 });
    await page.waitForTimeout(1_500);
    await setMapView(page, 59.3, 18.0, 5);
    await page.waitForTimeout(350); // fetch done, prefetch timer (600 ms) still pending
    const during = overview.length;
    await setMapView(page, 40.0, -3.7, 5); // somewhere else before it fires
    await page.waitForTimeout(250);
    // Only the new view's own request: the old prefetch never went out.
    expect(overview.length - during).toBeLessThanOrEqual(1);
  });
});
