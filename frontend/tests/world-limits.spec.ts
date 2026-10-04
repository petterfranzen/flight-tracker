import { expect, test } from "@playwright/test";
import { minZoomFor } from "../src/map/zoomLimits";
import { mockFlightApi, setMapView, withMap } from "./helpers";

// A screen wider than one world used to show the world repeating beside
// itself when zoomed out or panned to an edge. Zooming out now stops where one
// world fills the screen, and panning can't leave the world.

test.describe("minZoomFor (pure)", () => {
  test("is the lowest zoom whose world covers the longer screen side", () => {
    expect(minZoomFor(400, 800)).toBe(2); // 1024px world covers a phone
    expect(minZoomFor(1280, 720)).toBe(3); // 2048px
    expect(minZoomFor(1400, 800)).toBe(3);
    expect(minZoomFor(2560, 1440)).toBe(4); // 4096px
    expect(minZoomFor(100, 100)).toBe(2); // never below the floor
  });
});

test.describe("world limits in the app", () => {
  for (const [name, w, h, expectedMin] of [
    ["laptop", 1400, 800, 3],
    ["phone", 400, 800, 2],
    ["ultrawide", 2560, 1000, 4],
  ] as const) {
    test(`${name}: zoom-out stops at ${expectedMin} and the view never leaves the world`, async ({ page }) => {
      await page.setViewportSize({ width: w, height: h });
      await mockFlightApi(page);
      await page.goto("/");
      await page.waitForSelector(".leaflet-container", { timeout: 10_000 });
      await expect.poll(() => withMap(page, (m) => m.getMinZoom())).toBe(expectedMin);

      await setMapView(page, 0, 170, 2); // below the minimum: clamped up
      const after = await withMap(page, (m) => {
        const b = m.getBounds();
        return { zoom: m.getZoom(), west: b.getWest(), east: b.getEast(), south: b.getSouth(), north: b.getNorth() };
      });
      expect(after.zoom).toBeGreaterThanOrEqual(expectedMin);
      expect(after.east).toBeLessThanOrEqual(180.5);
      expect(after.west).toBeGreaterThanOrEqual(-180.5);
      expect(after.north).toBeLessThanOrEqual(85.06);
      expect(after.south).toBeGreaterThanOrEqual(-85.06);
    });
  }

  test("resizing the window re-fits the minimum zoom", async ({ page }) => {
    await page.setViewportSize({ width: 400, height: 800 });
    await mockFlightApi(page);
    await page.goto("/");
    await expect.poll(() => withMap(page, (m) => m.getMinZoom())).toBe(2);
    await page.setViewportSize({ width: 1400, height: 800 });
    await expect.poll(() => withMap(page, (m) => m.getMinZoom()), { timeout: 5_000 }).toBe(3);
  });
});
