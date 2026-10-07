import { expect, test, type Page } from "@playwright/test";
import { mockFlightApi } from "./helpers";

// Cyberpunk basemap buffering (map/maplibreBasemap.ts): the boot screen
// waits for the basemap, which meanwhile renders the neighbouring zoom
// levels behind it, and the GL canvas is rendered with a margin around the
// viewport. Tiles are stubbed (empty vector tiles) so this runs offline.

const TILE = /tiles\.openfreemap\.org\/t\/(\d+)\//;

async function stubTiles(page: Page, opts: { dead?: boolean } = {}): Promise<{ zooms: number[] }> {
  const seen = { zooms: [] as number[] };
  if (opts.dead) {
    await page.route(/tiles\.openfreemap\.org/, (r) => r.abort());
    return seen;
  }
  await page.route("https://tiles.openfreemap.org/planet", (r) =>
    r.fulfill({ json: { tilejson: "3.0.0", tiles: ["https://tiles.openfreemap.org/t/{z}/{x}/{y}.pbf"], minzoom: 0, maxzoom: 14, vector_layers: [] } }),
  );
  await page.route(TILE, (r) => {
    seen.zooms.push(Number(TILE.exec(r.request().url())![1]));
    return r.fulfill({ body: Buffer.alloc(0), contentType: "application/x-protobuf" });
  });
  await page.route(/tiles\.openfreemap\.org\/fonts/, (r) => r.fulfill({ body: Buffer.alloc(0), contentType: "application/x-protobuf" }));
  return seen;
}

test("the boot screen waits for the basemap, which warms the next zoom level behind it", async ({ page }) => {
  const tiles = await stubTiles(page);
  await mockFlightApi(page, { realTiles: true });
  await page.goto("/");
  await page.waitForSelector(".boot-screen");
  await page.waitForSelector(".boot-screen--hidden, body:not(:has(.boot-screen))", { timeout: 15_000 });

  // Leaflet z6 is MapLibre z5 (512px tiles). MapLibre fetches lower zooms
  // itself, so only tiles one level *in* (z6) prove the warm-up ran.
  const leafletZoom = await page.evaluate(() => (document.querySelector(".leaflet-container") as unknown as { _leaflet_map: { getZoom(): number } })._leaflet_map.getZoom());
  expect(tiles.zooms).toContain(leafletZoom); // GL zoom (leafletZoom - 1) + 1
});

test("the GL canvas renders a margin around the viewport", async ({ page }) => {
  await stubTiles(page);
  await mockFlightApi(page, { realTiles: true });
  await page.goto("/");
  const canvas = page.locator(".leaflet-container canvas.maplibregl-canvas");
  await canvas.waitFor({ state: "attached", timeout: 15_000 });
  const [cw, vw] = await Promise.all([
    canvas.evaluate((c) => c.getBoundingClientRect().width),
    page.evaluate(() => document.querySelector(".leaflet-container")!.getBoundingClientRect().width),
  ]);
  expect(cw / vw).toBeCloseTo(1.2, 1); // padding 0.1 on each side
});

test("an unreachable tile server can't hold the boot screen forever", async ({ page }) => {
  test.setTimeout(30_000);
  await stubTiles(page, { dead: true });
  await mockFlightApi(page, { realTiles: true });
  await page.goto("/");
  await page.waitForSelector(".boot-screen");
  await page.waitForSelector(".boot-screen--hidden, body:not(:has(.boot-screen))", { timeout: 15_000 });
});
