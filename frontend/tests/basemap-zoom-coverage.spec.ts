import { expect, test, type Page } from "@playwright/test";
import { mockFlightApi } from "./helpers";

// Cyberpunk basemap: while Leaflet animates a zoom, the GL canvas is only
// CSS-scaled, so zooming out used to shrink it below the viewport and show
// the dark container as bands along the edges until the zoom finished
// (map/maplibreBasemap.ts renders it at the target zoom first). Tiles are
// stubbed (empty vector tiles) so this runs offline.

const TILE = /tiles\.openfreemap\.org\/t\/(\d+)\//;

async function stubTiles(page: Page): Promise<void> {
  await page.route("https://tiles.openfreemap.org/planet", (r) =>
    r.fulfill({ json: { tilejson: "3.0.0", tiles: ["https://tiles.openfreemap.org/t/{z}/{x}/{y}.pbf"], minzoom: 0, maxzoom: 14, vector_layers: [] } }),
  );
  await page.route(TILE, (r) => r.fulfill({ body: Buffer.alloc(0), contentType: "application/x-protobuf" }));
  await page.route(/tiles\.openfreemap\.org\/fonts/, (r) => r.fulfill({ body: Buffer.alloc(0), contentType: "application/x-protobuf" }));
}

/** Runs an animated zoom and returns the worst edge gap (px) between the viewport and the GL canvas over every frame of it. */
async function worstGapDuring(page: Page, fromZoom: number, toZoom: number): Promise<number> {
  await page.evaluate((z) => (document.querySelector(".leaflet-container") as any)._leaflet_map.setView([59.3, 18.0], z, { animate: false }), fromZoom);
  await page.waitForTimeout(800);
  return page.evaluate(async (z) => {
    const map = (document.querySelector(".leaflet-container") as any)._leaflet_map;
    const canvas = document.querySelector(".leaflet-container canvas.maplibregl-canvas") as HTMLCanvasElement;
    const view = document.querySelector(".leaflet-container")!.getBoundingClientRect();
    let worst = 0;
    let running = true;
    const sample = (): void => {
      const c = canvas.getBoundingClientRect();
      worst = Math.max(worst, c.left - view.left, c.top - view.top, view.right - c.right, view.bottom - c.bottom);
      if (running) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
    map.setZoom(z, { animate: true });
    await new Promise((r) => setTimeout(r, 700));
    running = false;
    return worst;
  }, toZoom);
}

test.describe("GL basemap coverage while zooming", () => {
  test.beforeEach(async ({ page }) => {
    await stubTiles(page);
    await mockFlightApi(page, { realTiles: true });
    await page.goto("/");
    await page.locator(".leaflet-container canvas.maplibregl-canvas").waitFor({ state: "attached", timeout: 15_000 });
    await page.waitForSelector(".boot-screen--hidden, body:not(:has(.boot-screen))", { timeout: 15_000 });
  });

  for (const [from, to] of [
    [8, 7],
    [9, 7],
    [10, 6],
    [7, 8],
    [6, 9],
  ]) {
    test(`zoom ${from} -> ${to} never exposes the viewport edges`, async ({ page }) => {
      expect(await worstGapDuring(page, from, to)).toBeLessThanOrEqual(1);
    });
  }
});
