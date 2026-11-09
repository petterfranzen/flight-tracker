import { expect, test } from "@playwright/test";
import { mockFlightApi, waitForMapReady } from "./helpers";

// iOS 26 installed-app bottom band (WebKit 301108). The bug itself only
// reproduces on a phone; these pin the mechanism: standalone is detected by
// iOS's own flag, the shell still fills the viewport, nothing scrolls, and
// the ?vpdebug readout reports the numbers.

test.describe("standalone viewport", () => {
  test.describe.configure({ timeout: 60_000 });
  test.use({ viewport: { width: 390, height: 664 } });

  test("installed (navigator.standalone): html is marked, shell fills the viewport, page does not scroll", async ({ page }) => {
    await page.addInitScript(() => Object.defineProperty(navigator, "standalone", { get: () => true }));
    await mockFlightApi(page);
    await page.goto("/");
    await waitForMapReady(page);
    await expect(page.locator("html")).toHaveClass(/\bstandalone\b/);
    await expect.poll(async () => (await page.locator(".app-shell").boundingBox())?.height).toBe(664);
    await page.mouse.wheel(0, 400);
    expect(await page.evaluate(() => scrollY)).toBe(0);
    await expect(page.getByText(/fixed probe/)).toHaveCount(0);
  });

  test("in the browser: not marked, shell is the viewport", async ({ page }) => {
    await mockFlightApi(page);
    await page.goto("/");
    await waitForMapReady(page);
    await expect(page.locator("html")).not.toHaveClass(/\bstandalone\b/);
    await expect.poll(async () => (await page.locator(".app-shell").boundingBox())?.height).toBe(664);
  });

  test("?vpdebug shows the viewport readout", async ({ page }) => {
    await mockFlightApi(page);
    await page.goto("/?vpdebug");
    await waitForMapReady(page);
    await expect(page.getByText(/inner 390x664/)).toBeVisible();
    await expect(page.getByText(/fixed probe h 664/)).toBeVisible();
  });

  test("five quick taps on the Active/Seen counter show the readout (no address bar when installed)", async ({ page }) => {
    await mockFlightApi(page);
    await page.goto("/");
    await waitForMapReady(page);
    const chip = page.locator(".tracked-chip-rows");
    for (let i = 0; i < 5; i++) await chip.click();
    await expect(page.getByText(/fixed probe h 664/)).toBeVisible();
  });
});
