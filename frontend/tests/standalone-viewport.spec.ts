import { expect, test } from "@playwright/test";
import { mockFlightApi, waitForMapReady } from "./helpers";

// #196 follow-up: in the installed iOS app the layout viewport stops short of
// the home-indicator strip, so the shell must be sized to the physical screen.
// Simulated here: a 390x664 viewport on a 390x844 screen, running standalone
// by iOS's own flag (navigator.standalone), which is what the phone reports.

test.describe("standalone viewport", () => {
  test.describe.configure({ timeout: 60_000 });
  test.use({ viewport: { width: 390, height: 664 }, screen: { width: 390, height: 844 } });

  test("installed: the shell and the map reach the physical bottom of the screen", async ({ page }) => {
    await page.addInitScript(() => Object.defineProperty(navigator, "standalone", { get: () => true }));
    await mockFlightApi(page);
    await page.goto("/");
    await waitForMapReady(page);
    await expect(page.locator("html")).toHaveClass(/\bstandalone\b/);
    await expect.poll(async () => (await page.locator(".app-shell").boundingBox())?.height).toBe(844);
    await expect.poll(async () => (await page.locator(".maplibregl-canvas").boundingBox())?.height).toBe(844);
  });

  test("in the browser: nothing changes, the shell is the viewport", async ({ page }) => {
    await mockFlightApi(page);
    await page.goto("/");
    await waitForMapReady(page);
    await expect(page.locator("html")).not.toHaveClass(/\bstandalone\b/);
    await expect.poll(async () => (await page.locator(".app-shell").boundingBox())?.height).toBe(664);
  });
});
