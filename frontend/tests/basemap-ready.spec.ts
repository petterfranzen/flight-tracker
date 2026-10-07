import { expect, test, type Page } from "@playwright/test";
import { mockFlightApi } from "./helpers";

// The boot screen waits for the basemap's first full render (the map's first
// `idle`, see map/maplibreBasemap.ts whenBasemapReady), capped so a slow or
// dead tile server can't hold it. Tiles are stubbed (empty vector tiles) so
// this runs offline.

const TILE = /tiles\.openfreemap\.org\/t\/(\d+)\//;
const BOOT_HIDDEN = ".boot-screen--hidden, body:not(:has(.boot-screen))";

/** Serves an empty tileset; tile responses wait for `release()` when `hold` is set. */
async function stubTiles(page: Page, opts: { dead?: boolean; hold?: boolean } = {}): Promise<{ requested: () => number; release: () => void }> {
  let count = 0;
  let release: () => void = () => {};
  const gate = opts.hold ? new Promise<void>((resolve) => (release = resolve)) : Promise.resolve();
  if (opts.dead) {
    await page.route(/tiles\.openfreemap\.org/, (r) => r.abort());
    return { requested: () => count, release };
  }
  await page.route("https://tiles.openfreemap.org/planet", (r) =>
    r.fulfill({ json: { tilejson: "3.0.0", tiles: ["https://tiles.openfreemap.org/t/{z}/{x}/{y}.pbf"], minzoom: 0, maxzoom: 14, vector_layers: [] } }),
  );
  await page.route(TILE, async (r) => {
    count++;
    await gate;
    await r.fulfill({ body: Buffer.alloc(0), contentType: "application/x-protobuf" }).catch(() => {});
  });
  await page.route(/tiles\.openfreemap\.org\/fonts/, (r) => r.fulfill({ body: Buffer.alloc(0), contentType: "application/x-protobuf" }));
  return { requested: () => count, release };
}

test("the boot screen waits for the basemap's tiles, then lifts", async ({ page }) => {
  const tiles = await stubTiles(page, { hold: true });
  await mockFlightApi(page, { realTiles: true });
  await page.goto("/");
  await page.waitForSelector(".boot-screen");
  await expect.poll(tiles.requested, { timeout: 10_000 }).toBeGreaterThan(0);
  // Aircraft data is long in (it's mocked); only the basemap is outstanding.
  await page.waitForTimeout(1_500);
  await expect(page.locator(".boot-screen")).not.toHaveClass(/boot-screen--hidden/);
  tiles.release();
  await page.waitForSelector(BOOT_HIDDEN, { timeout: 5_000 });
});

test("an unreachable tile server can't hold the boot screen forever", async ({ page }) => {
  test.setTimeout(30_000);
  await stubTiles(page, { dead: true });
  await mockFlightApi(page, { realTiles: true });
  await page.goto("/");
  await page.waitForSelector(".boot-screen");
  await page.waitForSelector(BOOT_HIDDEN, { timeout: 15_000 });
});
