import { expect, test } from "@playwright/test";
import { mockFlightApi } from "./helpers";

// Leaflet caches the container size and only re-reads it on a window resize.
// On phones the container changes size without one (dynamic toolbars, the
// flex layout settling), which left tiles covering only part of the screen.
// map.ts re-measures on container and visual-viewport changes.

test.describe("map re-measures its container", () => {
  test("a container resize with no window resize is picked up", async ({ page }) => {
    await mockFlightApi(page);
    await page.goto("/");
    await page.waitForSelector(".leaflet-container", { timeout: 10_000 });
    const size = () => page.evaluate(() => {
      const c = document.querySelector(".leaflet-container") as HTMLElement & { _leaflet_map: { getSize(): { x: number; y: number } } };
      return { leaflet: c._leaflet_map.getSize().y, real: Math.round(c.getBoundingClientRect().height) };
    });
    await expect.poll(size).toEqual({ leaflet: expect.any(Number), real: expect.any(Number) });
    // Shrink the container directly: no window resize event fires.
    await page.evaluate(() => {
      const c = document.querySelector(".leaflet-container") as HTMLElement;
      c.style.height = "200px";
      c.style.flex = "none";
    });
    await expect.poll(async () => (await size()).leaflet, { timeout: 5_000 }).toBe(200);
  });

  test("?debug shows the diagnostics panel; without it there is none", async ({ page }) => {
    await mockFlightApi(page);
    await page.goto("/");
    await page.waitForSelector(".leaflet-container", { timeout: 10_000 });
    await expect(page.locator("pre", { hasText: "container" })).toHaveCount(0);
    await page.goto("/?debug");
    await expect(page.locator("pre", { hasText: /container \d+x\d+\s+leaflet \d+x\d+/ })).toBeVisible({ timeout: 10_000 });
  });
});
