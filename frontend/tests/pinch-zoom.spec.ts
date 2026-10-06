import { expect, test } from "@playwright/test";
import { mockFlightApi, setMapView, withMap } from "./helpers";

// A two-finger pinch (real touch events through Chromium's gesture synthesis) still zooms the map:
// the stepped wheel handler must not get in the way of Leaflet's touch zoom.
test.use({ hasTouch: true, viewport: { width: 400, height: 800 } });

test("pinching out zooms in, pinching in zooms out", async ({ page }) => {
  await mockFlightApi(page);
  await page.goto("/");
  await page.waitForSelector(".leaflet-container", { timeout: 10_000 });
  await setMapView(page, 59.3, 18.0, 7);
  const cdp = await page.context().newCDPSession(page);
  const pinch = async (scaleFactor: number) => {
    await cdp.send("Input.synthesizePinchGesture", { x: 200, y: 400, scaleFactor, relativeSpeed: 400, gestureSourceType: "touch" });
    await page.waitForTimeout(700);
  };
  const zoom = () => withMap(page, (m) => m.getZoom());
  await pinch(2.5);
  expect(await zoom()).toBeGreaterThanOrEqual(8);
  const zoomedIn = await zoom();
  await pinch(0.4);
  expect(await zoom()).toBeLessThan(zoomedIn);
});
