import { expect, test, type Page } from "@playwright/test";
import { freezeClock, mockFlightApi, setMapView, waitForMapReady, withMap } from "./helpers";

// Wheel and touchpad zoom are MapLibre's own (map/map.ts): continuous and
// fractional, and every input counts. One 100 px mouse-wheel notch is about
// half a level (WHEEL_ZOOM_RATE); the old stepper made it a whole level and
// dropped any input during its cooldown.

const zoom = (page: Page) => withMap(page, (m) => m.getZoom());

/** Waits until the map has stopped moving (the gesture's moveend has fired). */
async function settled(page: Page): Promise<void> {
  await page.waitForTimeout(100);
  await expect.poll(() => withMap(page, (m) => m.isMoving()), { timeout: 5_000 }).toBe(false);
  await page.waitForTimeout(300); // MapLibre ends a wheel gesture 200 ms after its last frame
}

async function openAt(page: Page, z: number): Promise<void> {
  await mockFlightApi(page);
  await page.goto("/");
  await waitForMapReady(page);
  await page.waitForSelector("body:not(:has(.boot-screen))", { timeout: 15_000 }); // it covers the map until then
  await setMapView(page, 59.3, 18.0, z);
  const box = (await page.locator(".map-container").boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
}

test.describe("wheel and touchpad zoom", () => {
  test("one wheel notch zooms about half a level, and the zoom stays fractional", async ({ page }) => {
    await openAt(page, 7);
    await page.mouse.wheel(0, -100);
    await settled(page);
    const z = await zoom(page);
    expect(z).toBeGreaterThan(7.35);
    expect(z).toBeLessThan(7.65);
    await page.mouse.wheel(0, 100);
    await settled(page);
    expect(await zoom(page)).toBeCloseTo(7, 1);
  });

  test("several fast notches all count", async ({ page }) => {
    await openAt(page, 7);
    for (let i = 0; i < 4; i++) {
      await page.mouse.wheel(0, -100);
      await page.waitForTimeout(40);
    }
    await settled(page);
    // Four notches inside one gesture: well past what one or two would do
    // (the stepper dropped everything after the first), compressed a little
    // where two land in the same frame.
    const gain = (await zoom(page)) - 7;
    expect(gain).toBeGreaterThan(1.2);
    expect(gain).toBeLessThan(2.2);
  });

  test("a touchpad pinch (a ctrl+wheel stream) zooms continuously, not in one jump", async ({ page }) => {
    // 80 rendered frames: on a busy machine (software WebGL) that alone can outlast the default 30 s.
    test.slow();
    await openAt(page, 7);
    // Small ctrl+wheel deltas every frame, the way a touchpad reports a
    // pinch; the zoom is sampled after each one.
    const samples = await page.evaluate(async () => {
      const map = (document.querySelector(".map-container") as unknown as { _flightMap: { getZoom(): number } })._flightMap;
      const canvas = document.querySelector(".map-container canvas.maplibregl-canvas")!;
      const r = canvas.getBoundingClientRect();
      const out: number[] = [];
      for (let i = 0; i < 40; i++) {
        canvas.dispatchEvent(new WheelEvent("wheel", { deltaY: -3, ctrlKey: true, bubbles: true, cancelable: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 }));
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        out.push(map.getZoom());
      }
      return out;
    });
    for (let i = 1; i < samples.length; i++) expect(samples[i]).toBeGreaterThanOrEqual(samples[i - 1]);
    // Many small steps on the way, not a single jump.
    expect(new Set(samples.map((z) => z.toFixed(3))).size).toBeGreaterThan(20);
    const gain = samples[samples.length - 1] - 7;
    expect(gain).toBeGreaterThan(0.2);
    expect(gain).toBeLessThan(2);
  });

  test("it zooms around the pointer, and the page does not scroll", async ({ page }) => {
    await openAt(page, 7);
    const box = (await page.locator(".map-container").boundingBox())!;
    const px = box.width * 0.75;
    const py = box.height * 0.25;
    const before = await withMap(page, (m, x: number, y: number) => m.unproject(x, y), px, py);
    await page.mouse.move(box.x + px, box.y + py);
    await page.mouse.wheel(0, -100);
    await settled(page);
    expect(await zoom(page)).toBeGreaterThan(7.3);
    const after = await withMap(page, (m, x: number, y: number) => m.unproject(x, y), px, py);
    expect(Math.abs(after.lat - before.lat)).toBeLessThan(0.05);
    expect(Math.abs(after.lon - before.lon)).toBeLessThan(0.05);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
  });

  test("the GL canvas covers the whole viewport on every frame of a zoom", async ({ page }) => {
    // The old Leaflet bridge only CSS-scaled the canvas during a zoom, which
    // showed the container as bands along the edges on a zoom-out.
    await openAt(page, 9);
    const worst = await page.evaluate(async () => {
      const map = (document.querySelector(".map-container") as unknown as { _flightMap: { setZoom(z: number): void } })._flightMap;
      const canvas = document.querySelector(".map-container canvas.maplibregl-canvas")!;
      const view = document.querySelector(".map-container")!.getBoundingClientRect();
      let gap = 0;
      let running = true;
      const sample = (): void => {
        const c = canvas.getBoundingClientRect();
        gap = Math.max(gap, c.left - view.left, c.top - view.top, view.right - c.right, view.bottom - c.bottom);
        if (running) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
      map.setZoom(7);
      await new Promise((r) => setTimeout(r, 600));
      running = false;
      return gap;
    });
    expect(worst).toBeLessThanOrEqual(1);
  });
});

test.describe("data stays keyed by whole zoom levels", () => {
  test("an overview request at a fractional zoom asks for the nearest whole level's grid, and its cache serves that level", async ({ page }) => {
    const grids: number[] = [];
    await mockFlightApi(page);
    await page.route("**/api/flights/live/overview*", (route) => {
      grids.push(Number(new URL(route.request().url()).searchParams.get("gridDeg")));
      return route.fulfill({ json: { planes: [], clusters: [] } });
    });
    // The page's clock moves only past each debounce: no neighbour prefetch
    // (600 ms after a view lands) gets in among the viewport's requests, and
    // the cached view can't age out (8 s) however slow the machine.
    await freezeClock(page);
    await page.goto("/");
    await waitForMapReady(page);

    await setMapView(page, 59.3, 18.0, 6);
    await page.clock.runFor(300); // past the viewport debounce (250 ms)
    await expect.poll(() => grids.length, { timeout: 5_000 }).toBeGreaterThan(0);
    const wholeLevelGrid = grids[0];

    // Somewhere else (nothing cached there), at a fractional zoom that rounds to 6.
    grids.length = 0;
    await setMapView(page, 45.0, 5.0, 6.3);
    await page.clock.runFor(300);
    await expect.poll(() => grids.length, { timeout: 5_000 }).toBeGreaterThan(0);
    expect(grids[0]).toBe(wholeLevelGrid);

    // Back to the first place at another fraction of the same level (a
    // little closer in, so the cached view covers it): served from the view
    // cache, no request of its own.
    grids.length = 0;
    await setMapView(page, 59.3, 18.0, 6.2);
    await page.clock.runFor(300);
    await page.waitForTimeout(300); // a request it made would have been recorded by now
    expect(grids).toEqual([]);
  });
});
