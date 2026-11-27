import { expect, test, type Page } from "@playwright/test";
import { INITIAL_MAX_PLANES, INITIAL_MIN_PLANES, LOCAL_EMPTY_BELOW, pickInitialView, planesInWindow } from "../src/map/initialView";
import { clampInitialZoom, roundView, SAVED_VIEW_KEY } from "../src/map/savedView";
import { freezeClock, mockFlightApi, setMapView, waitForMapReady, withMap } from "./helpers";

// The map opens where there is traffic, at a zoom that draws individual
// aircraft, not on a wide view of aggregated bubbles (which reads as broken).
// See map/initialView.ts. Default view is Stockholm (59.33, 18.06), zoom 6.

const DEFAULT = { lat: 59.33, lon: 18.06 };
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 400, height: 800 };
const cell = (lat: number, lon: number, count: number) => ({ lat, lon, count });

test.describe("pickInitialView (pure)", () => {
  test("keeps the default centre when it already has enough planes, at zoom 8", () => {
    const v = pickInitialView([cell(59.4, 18.1, INITIAL_MIN_PLANES + 5), cell(40, -3, 500)], DEFAULT, DESKTOP)!;
    expect(v.zoom).toBe(8);
    expect(v.lat).toBe(DEFAULT.lat);
    expect(v.lon).toBe(DEFAULT.lon);
  });

  test("a crowded default window opens one level closer", () => {
    const v = pickInitialView([cell(59.4, 18.1, INITIAL_MAX_PLANES + 50)], DEFAULT, DESKTOP)!;
    expect(v.zoom).toBe(9);
    expect(v.lat).toBe(DEFAULT.lat);
  });

  test("an empty default area moves to the busiest area in the world", () => {
    const v = pickInitialView([cell(50.1, 8.6, 80), cell(51.5, -0.5, 200), cell(35, 139, 90)], DEFAULT, DESKTOP)!;
    expect(v.lat).toBe(51.5);
    expect(v.lon).toBe(-0.5);
    expect(v.zoom).toBe(8);
    expect(v.planes).toBe(200);
  });

  test("a quiet window zooms out around the default centre before leaving the area", () => {
    // 20 planes at zoom 8 (< 25), but 80 within reach one level out: stay in Stockholm at zoom 7.
    const summary = [cell(59.33, 18.06, 20), cell(59.33, 23.5, 30), cell(59.33, 12.6, 30), cell(40, -3, 900)];
    expect(planesInWindow(summary, DEFAULT, 8, DESKTOP)).toBe(20);
    const v = pickInitialView(summary, DEFAULT, DESKTOP)!;
    expect(v.lat).toBe(DEFAULT.lat);
    expect(v.zoom).toBe(7);
    expect(v.planes).toBe(80);
  });

  test("a sparse (not empty) area keeps the default view instead of leaving", () => {
    expect(pickInitialView([cell(59.4, 18.1, LOCAL_EMPTY_BELOW + 2), cell(40, -3, 900)], DEFAULT, DESKTOP)).toBeNull();
  });

  test("equally busy areas: the one nearest the default wins", () => {
    const v = pickInitialView([cell(35, 139, 100), cell(50, 8, 100)], DEFAULT, DESKTOP)!;
    expect(v.lat).toBe(50);
  });

  test("returns null (keep the default view) when nowhere has enough traffic", () => {
    expect(pickInitialView([cell(50, 8, INITIAL_MIN_PLANES - 1)], DEFAULT, DESKTOP)).toBeNull();
    expect(pickInitialView([], DEFAULT, DESKTOP)).toBeNull();
  });

  test("the window is the viewport: a phone sees less of the same summary than a desktop", () => {
    // Three cells 2 degrees apart, 10 planes each: a desktop zoom-8 window (about 8 x 4 degrees) holds all of them, a phone's (about 2.2 x 3.5) only one.
    const summary = [cell(59.33, 16.06, 10), cell(59.33, 18.06, 10), cell(59.33, 20.06, 10)];
    expect(planesInWindow(summary, DEFAULT, 8, DESKTOP)).toBe(30);
    expect(planesInWindow(summary, DEFAULT, 8, PHONE)).toBe(10);
    expect(pickInitialView(summary, DEFAULT, DESKTOP)!.zoom).toBe(8);
    // The phone zooms out around the same centre rather than jumping elsewhere (the Stockholm-to-Orlando bug).
    const phone = pickInitialView([...summary, cell(28.4, -81.3, 900)], DEFAULT, PHONE)!;
    expect(phone.lat).toBe(DEFAULT.lat);
    expect(phone.zoom).toBe(7);
  });

  test("a saved view is rounded to 0.01 degrees and a whole zoom level", () => {
    expect(roundView(59.33492, 18.06371, 8.6)).toEqual({ lat: 59.33, lon: 18.06, zoom: 9 });
    expect(roundView(-33.86514, 151.20929, 11.2)).toEqual({ lat: -33.87, lon: 151.21, zoom: 11 });
  });

  test("a saved zoom that would draw only bubbles is lifted to INITIAL_ZOOM, a closer one kept", () => {
    expect(clampInitialZoom(5)).toBe(8);
    expect(clampInitialZoom(2)).toBe(8);
    expect(clampInitialZoom(8)).toBe(8);
    expect(clampInitialZoom(11.4)).toBe(11.4);
  });
});

async function open(page: import("@playwright/test").Page, clusters: ReturnType<typeof cell>[], geo?: { lat: number; lon: number } | null) {
  await mockFlightApi(page, { clusters, geo });
  await page.setViewportSize(DESKTOP);
  // The opening view gives the summary 1.5 s (INITIAL_VIEW_TIMEOUT_MS), then
  // keeps the default. A busy machine could miss that with mocked data, so
  // the page's clock stands still: only the data decides.
  await freezeClock(page);
  await page.goto("/");
  await waitForMapReady(page);
}

test.describe("opening view in the app", () => {
  test("opens on the busiest area at an individual-aircraft zoom when the default area is quiet", async ({ page }) => {
    await open(page, [cell(50.1, 8.6, 90)]);
    await expect.poll(() => withMap(page, (m) => m.getZoom()), { timeout: 10_000 }).toBe(8);
    const c = await withMap(page, (m) => m.getCenter());
    expect(c.lat).toBeCloseTo(50.1, 1);
    expect(c.lon).toBeCloseTo(8.6, 1);
  });

  test("opens at the default centre, zoom 8, when it already has enough traffic", async ({ page }) => {
    await open(page, [cell(59.4, 18.1, 60)]);
    await expect.poll(() => withMap(page, (m) => m.getZoom()), { timeout: 10_000 }).toBe(8);
    const c = await withMap(page, (m) => m.getCenter());
    expect(c.lat).toBeCloseTo(59.33, 1);
    expect(c.lon).toBeCloseTo(18.06, 1);
  });

  const MANCHESTER = { lat: 53.5, lon: -2.2 };

  test("opens near the visitor's location instead of the default, at a zoom with traffic", async ({ page }) => {
    // Plenty of traffic around Stockholm too: without the visitor's location the default centre would win.
    await open(page, [cell(53.4, -2.3, 40), cell(53.6, -2.1, 40), cell(59.4, 18.1, 120)], MANCHESTER);
    await expect.poll(() => withMap(page, (m) => m.getCenter().lat), { timeout: 10_000 }).toBeCloseTo(53.5, 0);
    const c = await withMap(page, (m) => m.getCenter());
    expect(c.lon).toBeCloseTo(-2.2, 0);
    expect(await withMap(page, (m) => m.getZoom())).toBeGreaterThanOrEqual(6);
  });

  test("a visitor's location with no traffic data still opens there, at the default zoom", async ({ page }) => {
    await open(page, [], MANCHESTER);
    await expect.poll(() => withMap(page, (m) => m.getCenter().lat), { timeout: 10_000 }).toBeCloseTo(53.5, 0);
    expect(await withMap(page, (m) => m.getZoom())).toBe(6);
  });

  test("no location from the server keeps the default view", async ({ page }) => {
    await open(page, [], null);
    const c = await withMap(page, (m) => m.getCenter());
    expect(c.lat).toBeCloseTo(59.33, 1);
    expect(c.lon).toBeCloseTo(18.06, 1);
  });

  test("with no usable traffic data the default view is kept", async ({ page }) => {
    await open(page, []);
    expect(await withMap(page, (m) => m.getZoom())).toBe(6);
  });

  test("a map the user has already moved is left where they put it", async ({ page }) => {
    await mockFlightApi(page, { clusters: [cell(50.1, 8.6, 90)] });
    // Hold the world summary until the test has moved the map.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    await page.route("**/api/flights/live/clusters*", async (route) => {
      await gate;
      await route.fulfill({ json: [cell(50.1, 8.6, 90)] }).catch(() => {});
    });
    await page.setViewportSize(DESKTOP);
    await freezeClock(page); // as in open(): the summary can't time out
    await page.goto("/");
    await page.waitForSelector(".map-container", { timeout: 10_000 }); // not ready: the summary is held
    await setMapView(page, 10, 10, 5);
    release();
    await waitForMapReady(page); // the opening view has seen the summary
    expect(await withMap(page, (m) => m.getZoom())).toBe(5);
    const c = await withMap(page, (m) => m.getCenter());
    expect(c.lat).toBeCloseTo(10, 1);
  });

  // The saved view (map/savedView.ts, section9-hq#447): the map opens where the
  // user last looked. Cloudflare's IP lookup often puts a Swedish ISP address in
  // the wrong city, which is exactly the case here — Gothenburg, not Stockholm.
  const GOTHENBURG = { lat: 57.7, lon: 11.97 };
  const STOCKHOLM = { lat: 59.33, lon: 18.06 };
  const seedSavedView = (page: Page, view: { lat: number; lon: number; zoom: number; savedAt: number }) =>
    page.addInitScript(
      (v: { key: string; view: unknown }) => {
        try {
          localStorage.setItem(v.key, JSON.stringify(v.view));
        } catch {
          // best-effort, like the app
        }
      },
      { key: SAVED_VIEW_KEY, view },
    );

  test("opens on a saved view instead of the server's location guess", async ({ page }) => {
    await seedSavedView(page, { ...STOCKHOLM, zoom: 11, savedAt: Date.now() });
    await open(page, [cell(GOTHENBURG.lat, GOTHENBURG.lon, 60)], GOTHENBURG);
    await expect.poll(() => withMap(page, (m) => m.getZoom()), { timeout: 10_000 }).toBe(11);
    const c = await withMap(page, (m) => m.getCenter());
    expect(c.lat).toBeCloseTo(STOCKHOLM.lat, 1);
    expect(c.lon).toBeCloseTo(STOCKHOLM.lon, 1);
  });

  test("a saved zoom that would draw only bubbles opens at INITIAL_ZOOM, at the saved centre", async ({ page }) => {
    await seedSavedView(page, { ...STOCKHOLM, zoom: 5, savedAt: Date.now() });
    await open(page, [cell(GOTHENBURG.lat, GOTHENBURG.lon, 60)], GOTHENBURG);
    await expect.poll(() => withMap(page, (m) => m.getZoom()), { timeout: 10_000 }).toBe(8);
    const c = await withMap(page, (m) => m.getCenter());
    expect(c.lat).toBeCloseTo(STOCKHOLM.lat, 1);
    expect(c.lon).toBeCloseTo(STOCKHOLM.lon, 1);
  });

  test("a saved view older than 30 days is ignored, so the location guess decides again", async ({ page }) => {
    await seedSavedView(page, { ...STOCKHOLM, zoom: 11, savedAt: Date.now() - 31 * 24 * 60 * 60 * 1000 });
    await open(page, [cell(GOTHENBURG.lat, GOTHENBURG.lon, 60)], GOTHENBURG);
    await expect.poll(() => withMap(page, (m) => m.getCenter().lat), { timeout: 10_000 }).toBeCloseTo(GOTHENBURG.lat, 1);
    const c = await withMap(page, (m) => m.getCenter());
    expect(c.lon).toBeCloseTo(GOTHENBURG.lon, 1);
  });

  test("with no saved view the current behaviour is unchanged: the server's location decides", async ({ page }) => {
    await open(page, [cell(53.5, -2.2, 60)], MANCHESTER);
    await expect.poll(() => withMap(page, (m) => m.getCenter().lat), { timeout: 10_000 }).toBeCloseTo(53.5, 1);
  });

  test("a view the user settles on is saved, rounded, for the next visit", async ({ page }) => {
    await mockFlightApi(page);
    await page.setViewportSize(DESKTOP);
    await freezeClock(page);
    await page.goto("/");
    await waitForMapReady(page);
    // The boot screen waves itself away on its own timers (bootScreen.ts), which
    // a frozen clock holds: run them out before the map is reachable.
    await page.clock.runFor(3_200);
    await page.waitForSelector("body:not(:has(.boot-screen))", { timeout: 15_000 }); // it covers the map until then
    const box = (await page.locator(".map-container").boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx - 160, cy - 80, { steps: 8 });
    await page.mouse.up();
    await page.clock.runFor(1_200); // past the save debounce (1 s)
    await expect.poll(() => page.evaluate((key: string) => localStorage.getItem(key), SAVED_VIEW_KEY), { timeout: 5_000 }).not.toBeNull();
    const raw = await page.evaluate((key: string) => localStorage.getItem(key), SAVED_VIEW_KEY);
    const saved = JSON.parse(raw ?? "null");
    const c = await withMap(page, (m) => m.getCenter());
    expect(saved.lat).toBeCloseTo(c.lat, 2);
    expect(saved.lon).toBeCloseTo(c.lon, 2);
    expect(Number.isInteger(saved.zoom)).toBe(true);
    expect(Number.isFinite(saved.savedAt)).toBe(true);
  });

  test("a programmatic view (a jump, not a user move) is not saved", async ({ page }) => {
    await mockFlightApi(page);
    await page.setViewportSize(DESKTOP);
    await freezeClock(page);
    await page.goto("/");
    await waitForMapReady(page);
    await setMapView(page, 10, 10, 8); // the app's own move, not a gesture
    await page.clock.runFor(1_200);
    expect(await page.evaluate((key: string) => localStorage.getItem(key), SAVED_VIEW_KEY)).toBeNull();
  });
});
