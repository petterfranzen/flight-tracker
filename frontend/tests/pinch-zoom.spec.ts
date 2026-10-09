import { expect, test } from "@playwright/test";
import { mockFlightApi, setMapView, waitForMapReady, withMap } from "./helpers";

// A two-finger pinch (real touch events through Chromium's gesture synthesis) zooms the map with
// MapLibre's own touch zoom, and ends wherever the fingers stopped: no snap back to a whole level.
test.use({ hasTouch: true, viewport: { width: 400, height: 800 } });

async function setup(page: import("@playwright/test").Page) {
  await mockFlightApi(page);
  await page.goto("/");
  await waitForMapReady(page);
  await page.waitForSelector(".boot-screen--hidden, body:not(:has(.boot-screen))", { timeout: 15_000 });
  await setMapView(page, 59.3, 18.0, 7);
  const cdp = await page.context().newCDPSession(page);
  const pinch = async (scaleFactor: number) => {
    await cdp.send("Input.synthesizePinchGesture", { x: 200, y: 400, scaleFactor, relativeSpeed: 400, gestureSourceType: "touch" });
    await page.waitForTimeout(700);
  };
  const zoom = () => withMap(page, (m) => m.getZoom());
  return { pinch, zoom };
}

test("pinching out zooms in, pinching in zooms out", async ({ page }) => {
  const { pinch, zoom } = await setup(page);
  await pinch(2.5);
  expect(await zoom()).toBeGreaterThanOrEqual(8);
  const zoomedIn = await zoom();
  await pinch(0.4);
  expect(await zoom()).toBeLessThan(zoomedIn);
});

test("a pinch ends at a fractional zoom (no snap to a whole level)", async ({ page }) => {
  const { pinch, zoom } = await setup(page);
  await pinch(1.5); // log2(1.5): about 0.58 of a level
  const z = await zoom();
  expect(z).toBeGreaterThan(7.2);
  expect(z).toBeLessThan(8);
  expect(Math.abs(z - Math.round(z))).toBeGreaterThan(0.05);
});
