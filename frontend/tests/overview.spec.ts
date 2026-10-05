import { expect, test } from "@playwright/test";
import { mockFlightApi, setMapView } from "./helpers";

// Zoomed out, the server sends a thinned-out set of active aircraft (one per
// half-icon cell, first discovered first; FlightController.liveOverview with
// declutter=true) and the map draws them as individual planes. No clusters.

const plane = (icao24: string, lat: number, lon: number) => ({
  icao24,
  callsign: icao24.toUpperCase(),
  observedAt: new Date().toISOString(),
  latitude: lat,
  longitude: lon,
  headingDeg: 90,
  onGround: false,
});

// A summary just under the opening-view threshold, so the map keeps its default view.
const QUIET_SUMMARY = [{ lat: 59.5, lon: 18.5, count: 12 }];

test.describe("zoomed-out overview", () => {
  test("the overview's aircraft are drawn individually, and nothing is clustered", async ({ page }) => {
    await mockFlightApi(page, {
      clusters: QUIET_SUMMARY,
      overviewPlanes: [plane("ov0001", 59.2, 17.9), plane("ov0002", 59.9, 20.5), plane("ov0003", 58.4, 15.0)], // well apart: none overlaps another at z6
    });
    await page.goto("/");
    await page.waitForSelector(".leaflet-container", { timeout: 10_000 });
    await setMapView(page, 59.3, 18.0, 6);
    await expect(page.locator(".plane-icon")).toHaveCount(3, { timeout: 5_000 });
    await expect(page.locator(".cluster-icon")).toHaveCount(0);
  });

  test("it asks the server for the cluster-free variant, with a cell about half an icon wide", async ({ page }) => {
    const urls: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes("/api/flights/live/overview")) urls.push(r.url());
    });
    await mockFlightApi(page, { clusters: QUIET_SUMMARY });
    await page.goto("/");
    await page.waitForSelector(".leaflet-container", { timeout: 10_000 });
    await setMapView(page, 59.3, 18.0, 5);
    await expect.poll(() => urls.length, { timeout: 5_000 }).toBeGreaterThan(0);
    const q = new URL(urls[urls.length - 1]).searchParams;
    expect(q.get("declutter")).toBe("true");
    const cellDeg = Number(q.get("gridDeg"));
    // z5: an icon box is ~45px, half of it ~22px = 22 * 360 / (256 * 32) deg.
    expect(cellDeg).toBeGreaterThan(0.5);
    expect(cellDeg).toBeLessThan(2.5);
  });

  test("an overview aircraft moves when the live feed reports it", async ({ page }) => {
    const first = plane("ov0001", 59.2, 17.9);
    await mockFlightApi(page, { clusters: QUIET_SUMMARY, overviewPlanes: [first] });
    let push: (frame: unknown) => void = () => {};
    await page.routeWebSocket("**/ws/live", (ws) => {
      push = (frame) => ws.send(JSON.stringify(frame));
    });
    await page.goto("/");
    await page.waitForSelector(".leaflet-container", { timeout: 10_000 });
    await setMapView(page, 59.3, 18.0, 6);
    const marker = page.locator(".plane-icon");
    await expect(marker).toHaveCount(1, { timeout: 5_000 });
    const before = await marker.boundingBox();

    push({ ...first, latitude: 59.2, longitude: 19.4, observedAt: new Date(Date.now() + 5_000).toISOString() });
    await expect.poll(async () => (await marker.boundingBox())?.x ?? 0, { timeout: 5_000 }).toBeGreaterThan(before!.x + 20);
  });
});
