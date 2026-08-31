import { expect, test } from "@playwright/test";
import { findMarkerNear, LIVE_FIXTURE, mockFlightApi, setMapView } from "./helpers";

// Verifies the mobile hide-by-default/reveal-on-demand treatment (see
// MOBILE_BREAKPOINT_PX in FlightMap.tsx) without disturbing desktop: every
// assertion here about desktop is "unchanged from before", every assertion
// about mobile is "the new collapsed/overlay/bottom-sheet behavior".

const MOBILE_VIEWPORT = { width: 390, height: 844 };
const DESKTOP_VIEWPORT = { width: 1440, height: 900 };

test.describe("mobile layout", () => {
  test("header hides, search collapses to a FAB, and the FAB expands to a full overlay", async ({ page }) => {
    await page.setViewportSize(MOBILE_VIEWPORT);
    await mockFlightApi(page);
    await page.goto("/");
    await page.waitForSelector(".leaflet-container", { timeout: 10_000 });

    await expect(page.locator(".app-header")).toBeHidden();

    const fab = page.locator(".flight-search-fab");
    await expect(fab).toBeVisible();
    // The actual search input must not be interactable while collapsed —
    // a hidden-but-present input someone could still tab into would be a
    // real regression, not just a cosmetic one.
    await expect(page.locator(".flight-search-input").first()).toBeHidden();

    await fab.click();
    await expect(page.locator(".flight-search-panel")).toHaveClass(/flight-search-panel--open/);
    await expect(page.locator(".flight-search-input").first()).toBeVisible();
    await expect(fab).toBeHidden(); // covered by the overlay, and CSS :has() removes it from the tab order

    await page.locator(".flight-search-panel-close").click();
    await expect(page.locator(".flight-search-panel")).not.toHaveClass(/flight-search-panel--open/);
    await expect(fab).toBeVisible();

    await page.screenshot({ path: "/tmp/mobile-layout-collapsed.png" });
    await fab.click();
    await page.screenshot({ path: "/tmp/mobile-layout-search-open.png" });
  });

  test("selecting an aircraft opens the dossier as a bottom sheet, not a side panel", async ({ page }) => {
    await page.setViewportSize(MOBILE_VIEWPORT);
    await mockFlightApi(page);
    await page.goto("/");
    await page.waitForSelector(".leaflet-container", { timeout: 10_000 });

    const target = LIVE_FIXTURE.find((p) => p.icao24 === "4aad15")!;
    await setMapView(page, target.latitude, target.longitude, 11);
    await page.waitForSelector(".plane-icon", { timeout: 10_000 });
    await page.waitForTimeout(500);

    const marker = await findMarkerNear(page, target.latitude, target.longitude);
    await marker.click();

    const panel = page.locator(".details-panel");
    await expect(panel).toBeVisible();
    const box = await panel.boundingBox();
    expect(box).not.toBeNull();
    // Bottom sheet: full viewport width, anchored to the bottom, not a
    // ~300px-wide column on the right (the desktop layout).
    expect(box!.width).toBeGreaterThan(MOBILE_VIEWPORT.width * 0.9);
    // Within 15px, not exact — a scrollbar can shave a few px off the
    // effective viewport, which isn't the thing under test here.
    expect(Math.abs(box!.y + box!.height - MOBILE_VIEWPORT.height)).toBeLessThan(15);
    expect(box!.height).toBeLessThan(MOBILE_VIEWPORT.height * 0.75); // capped (max-height: 70vh), not full-screen

    await page.screenshot({ path: "/tmp/mobile-layout-dossier-sheet.png" });

    await page.locator(".details-panel-close").click();
    await expect(panel).toBeHidden();
  });

  test("desktop layout is unchanged: header, inline search, and side-panel dossier", async ({ page }) => {
    await page.setViewportSize(DESKTOP_VIEWPORT);
    await mockFlightApi(page);
    await page.goto("/");
    await page.waitForSelector(".leaflet-container", { timeout: 10_000 });

    await expect(page.locator(".app-header")).toBeVisible();
    await expect(page.locator(".flight-search-fab")).toBeHidden();
    await expect(page.locator(".flight-search-input").first()).toBeVisible();

    const target = LIVE_FIXTURE.find((p) => p.icao24 === "4aad15")!;
    await setMapView(page, target.latitude, target.longitude, 11);
    await page.waitForSelector(".plane-icon", { timeout: 10_000 });
    await page.waitForTimeout(500);
    const marker = await findMarkerNear(page, target.latitude, target.longitude);
    await marker.click();

    const panel = page.locator(".details-panel");
    await expect(panel).toBeVisible();
    const box = await panel.boundingBox();
    expect(box).not.toBeNull();
    // Unchanged side panel: fixed ~300px width, full viewport height, right-anchored.
    expect(box!.width).toBeLessThan(320);
    expect(Math.abs(box!.x + box!.width - DESKTOP_VIEWPORT.width)).toBeLessThan(15);
    expect(Math.abs(box!.height - DESKTOP_VIEWPORT.height)).toBeLessThan(15);

    await page.screenshot({ path: "/tmp/desktop-layout-dossier-panel.png" });
  });
});
