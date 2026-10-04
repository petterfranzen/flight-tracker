import { expect, test } from "@playwright/test";
import { mockFlightApi, setMapView } from "./helpers";

// Zoomed out, the server's most active aircraft are drawn as individual
// markers next to the clusters (FlightController.liveOverview), so the
// world doesn't look empty.

const plane = (icao24: string, lat: number, lon: number) => ({
  icao24,
  callsign: icao24.toUpperCase(),
  observedAt: new Date().toISOString(),
  latitude: lat,
  longitude: lon,
  headingDeg: 90,
  onGround: false,
});

test.describe("zoomed-out overview", () => {
  test("top active aircraft are drawn individually beside the clusters", async ({ page }) => {
    await mockFlightApi(page, {
      clusters: [{ lat: 59.5, lon: 18.5, count: 12 }],
      overviewPlanes: [plane("ov0001", 59.2, 17.9), plane("ov0002", 59.6, 18.4), plane("ov0003", 58.9, 18.8)],
    });
    await page.goto("/");
    await page.waitForSelector(".cluster-icon", { timeout: 10_000 });
    await setMapView(page, 59.3, 18.0, 6);
    await expect(page.locator(".plane-icon:not(.cluster-icon)")).toHaveCount(3, { timeout: 5_000 });
    await expect(page.locator(".cluster-icon")).toHaveCount(1);
  });

  test("larger clusters get larger bubbles", async ({ page }) => {
    await mockFlightApi(page, { clusters: [{ lat: 59.5, lon: 18.5, count: 12 }] });
    await page.goto("/");
    const box = await page.locator(".cluster-icon").first().boundingBox();
    expect(box!.width).toBeGreaterThanOrEqual(50);
  });

  test("an overview aircraft moves when the live feed reports it", async ({ page }) => {
    const first = plane("ov0001", 59.2, 17.9);
    await mockFlightApi(page, { clusters: [{ lat: 59.5, lon: 18.5, count: 12 }], overviewPlanes: [first] });
    let push: (frame: unknown) => void = () => {};
    await page.routeWebSocket("**/ws/live", (ws) => {
      push = (frame) => ws.send(JSON.stringify(frame));
    });
    await page.goto("/");
    await page.waitForSelector(".cluster-icon", { timeout: 10_000 });
    await setMapView(page, 59.3, 18.0, 6);
    const marker = page.locator(".plane-icon:not(.cluster-icon)");
    await expect(marker).toHaveCount(1, { timeout: 5_000 });
    const before = await marker.boundingBox();

    push({ ...first, latitude: 59.2, longitude: 19.4, observedAt: new Date(Date.now() + 5_000).toISOString() });
    await expect.poll(async () => (await marker.boundingBox())?.x ?? 0, { timeout: 5_000 }).toBeGreaterThan(before!.x + 20);
  });

  test("a phone asks for fewer loose planes and coarser cells than a laptop", async ({ browser }) => {
    const ask = async (width: number, height: number) => {
      const ctx = await browser.newContext({ viewport: { width, height } });
      const page = await ctx.newPage();
      const urls: string[] = [];
      page.on("request", (r) => {
        if (r.url().includes("/api/flights/live/overview")) urls.push(r.url());
      });
      await mockFlightApi(page, { clusters: [{ lat: 59.5, lon: 18.5, count: 12 }] });
      await page.goto("/");
      await page.waitForSelector(".cluster-icon", { timeout: 10_000 });
      await setMapView(page, 59.3, 18.0, 5);
      await expect.poll(() => urls.length, { timeout: 5_000 }).toBeGreaterThan(0);
      const q = new URL(urls[urls.length - 1]).searchParams;
      await ctx.close();
      return { limit: q.get("limit"), gridDeg: Number(q.get("gridDeg")) };
    };
    const laptop = await ask(1280, 800);
    const phone = await ask(400, 800);
    expect(laptop.limit).toBeNull(); // the server default
    expect(phone.limit).toBe("40");
    expect(phone.gridDeg).toBeGreaterThan(laptop.gridDeg);
  });
});
