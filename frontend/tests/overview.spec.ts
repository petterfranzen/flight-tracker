import { expect, test } from "@playwright/test";
import { mockFlightApi, renderedPlanes, setMapView, waitForMapReady } from "./helpers";

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
    await waitForMapReady(page);
    await setMapView(page, 59.3, 18.0, 6);
    await expect.poll(async () => (await renderedPlanes(page)).length, { timeout: 5_000 }).toBe(3);
    await expect(page.locator(".cluster-icon")).toHaveCount(0);
  });

  test("it asks the server for the cluster-free variant, with a cell about half an icon wide", async ({ page }) => {
    const urls: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes("/api/flights/live/overview")) urls.push(r.url());
    });
    await mockFlightApi(page, { clusters: QUIET_SUMMARY });
    await page.goto("/");
    await waitForMapReady(page);
    await setMapView(page, 59.3, 18.0, 4);
    // The boot view's request (z6) comes first; wait for the z4 one: an icon box is ~25px, half of it
    // ~12px = 12 * 360 / (256 * 16) = ~1.1 deg.
    const lastCell = () => (urls.length ? Number(new URL(urls[urls.length - 1]).searchParams.get("gridDeg")) : 0);
    await expect.poll(lastCell, { timeout: 5_000 }).toBeGreaterThan(0.8);
    expect(lastCell()).toBeLessThan(1.6);
    expect(new URL(urls[urls.length - 1]).searchParams.get("declutter")).toBe("true");
  });

  test("an overview aircraft moves when the live feed reports it", async ({ page }) => {
    const first = plane("ov0001", 59.2, 17.9);
    await mockFlightApi(page, { clusters: QUIET_SUMMARY, overviewPlanes: [first] });
    let push: (frame: unknown) => void = () => {};
    await page.routeWebSocket("**/ws/live", (ws) => {
      push = (frame) => ws.send(JSON.stringify(frame));
    });
    await page.goto("/");
    await waitForMapReady(page);
    await setMapView(page, 59.3, 18.0, 6);
    const x = async () => (await renderedPlanes(page)).find((p) => p.icao24 === "ov0001")?.x ?? 0;
    await expect.poll(async () => (await renderedPlanes(page)).length, { timeout: 5_000 }).toBe(1);
    const before = await x();

    push({ ...first, latitude: 59.2, longitude: 19.4, observedAt: new Date(Date.now() + 5_000).toISOString() });
    await expect.poll(x, { timeout: 5_000 }).toBeGreaterThan(before + 20);
  });
});
