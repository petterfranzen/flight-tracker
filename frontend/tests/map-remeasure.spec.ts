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

  test("the GL basemap follows: a container that was small at first and then grows is fully covered", async ({ page }) => {
    // The cold-load case on a phone: the map is created while its container is still short.
    await page.route("https://tiles.openfreemap.org/planet", (r) =>
      r.fulfill({ json: { tilejson: "3.0.0", tiles: ["https://tiles.openfreemap.org/t/{z}/{x}/{y}.pbf"], minzoom: 0, maxzoom: 14, vector_layers: [] } }),
    );
    await page.route(/tiles\.openfreemap\.org\/(t|fonts)\//, (r) => r.fulfill({ body: Buffer.alloc(0), contentType: "application/x-protobuf" }));
    await mockFlightApi(page, { realTiles: true });
    // The page's own HTML with a rule that keeps the map container short until the test lifts it.
    await page.route(/\/(\?.*)?$/, async (route) => {
      if (route.request().resourceType() !== "document") return route.fallback();
      const r = await route.fetch();
      const body = (await r.text()).replace("</head>", '<style id="short-at-first">.leaflet-container{height:150px!important;flex:none!important}</style></head>');
      await route.fulfill({ response: r, body });
    });
    await page.goto("/");
    await page.locator("canvas.maplibregl-canvas").waitFor({ state: "attached", timeout: 15_000 });
    await page.waitForTimeout(1_000);
    await page.evaluate(() => document.getElementById("short-at-first")!.remove()); // layout settles; no window resize
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const c = document.querySelector(".leaflet-container")!.getBoundingClientRect();
          const g = document.querySelector("canvas.maplibregl-canvas")!.getBoundingClientRect();
          return Math.max(g.left - c.left, g.top - c.top, c.right - g.right, c.bottom - g.bottom) <= 1 && c.height > 300;
        }),
      { timeout: 8_000 })
      .toBe(true);
  });
});
