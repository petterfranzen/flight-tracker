import { test, expect } from "@playwright/test";

/**
 * Runs against a real production build (see playwright.config.ts's second
 * webServer), not the dev server every other spec uses.
 *
 * It exists because a bug shipped that only the production build had. Vite's
 * dev server and Rollup handle maplibre-gl's worker completely differently,
 * and maplibre resolves that worker's URL at runtime from import.meta.url
 * with a computed filename — so Rollup never emitted it, and the app asked
 * for an asset that wasn't there. Being a SPA, the host answered with
 * index.html and a 200, the Worker parsed HTML as a module, failed, and died
 * silently: no console error, no failed request. The map still fetched its
 * style and TileJSON on the main thread, so everything looked healthy while
 * it rendered nothing but a background colour.
 *
 * Asserting on .pbf responses rather than on pixels is deliberate: it's the
 * narrowest signal that tile *parsing* actually reached the worker, and it
 * fails loudly for exactly the class of bug that failed silently.
 */
const PREVIEW_URL = "http://localhost:4173/";

test("production build fetches real vector tiles, not just the style", async ({ page }) => {
  const tiles: number[] = [];
  const pageErrors: string[] = [];
  page.on("response", (r) => {
    if (/openfreemap.*\.pbf/.test(r.url())) tiles.push(r.status());
  });
  page.on("pageerror", (e) => pageErrors.push(e.message));

  await page.addInitScript(() => localStorage.setItem("flighttracker:theme", "cyberpunk"));
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(PREVIEW_URL, { waitUntil: "load" });
  // Tiles are a real network round-trip to OpenFreeMap; this is a generous
  // budget for a cold cache rather than a tuned timing.
  await page.waitForTimeout(12_000);

  expect(pageErrors, `unexpected page errors: ${pageErrors.join(" | ")}`).toHaveLength(0);
  expect(tiles.length, "no vector tiles were fetched — the worker is probably dead").toBeGreaterThan(0);
  expect(tiles.every((s) => s === 200), `non-200 tile responses: ${tiles.join(",")}`).toBe(true);
});
