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
    await page.waitForTimeout(900); // flyTo's own 800ms animation + invalidateSize/reflow

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
    // Collapsed default: bottom 1/3 of the viewport, not the old 70vh cap.
    expect(Math.abs(box!.height - MOBILE_VIEWPORT.height / 3)).toBeLessThan(15);
    await expect(page.locator(".details-panel-fields")).toBeHidden();

    // The actual regression this whole fix is for: the selected plane must
    // sit above the sheet, not underneath it (the old absolute-overlay
    // sheet left the map at full height, so flyTo centered the marker at
    // the *container's* true center — right behind the sheet).
    const collapsedMarker = await findMarkerNear(page, target.latitude, target.longitude);
    const collapsedMarkerBox = await collapsedMarker.boundingBox();
    expect(collapsedMarkerBox).not.toBeNull();
    expect(collapsedMarkerBox!.y + collapsedMarkerBox!.height).toBeLessThan(box!.y);

    await page.screenshot({ path: "/tmp/mobile-layout-dossier-collapsed.png" });

    // Expand: sheet grows to 2/3, map shrinks to 1/3, plane re-centers
    // within that smaller area and must still clear the (now much taller) sheet.
    await page.locator(".details-panel-expand-toggle").click();
    await page.waitForTimeout(800); // CSS height transition (250ms) + panTo's 500ms
    await expect(page.locator(".details-panel-fields")).toBeVisible();
    const expandedBox = await panel.boundingBox();
    expect(Math.abs(expandedBox!.height - (MOBILE_VIEWPORT.height * 2) / 3)).toBeLessThan(15);

    const expandedMarker = await findMarkerNear(page, target.latitude, target.longitude);
    const expandedMarkerBox = await expandedMarker.boundingBox();
    expect(expandedMarkerBox).not.toBeNull();
    expect(expandedMarkerBox!.y + expandedMarkerBox!.height).toBeLessThan(expandedBox!.y);

    await page.screenshot({ path: "/tmp/mobile-layout-dossier-expanded.png" });

    // Collapse back: height and marker position both return to the 1/3 state.
    await page.locator(".details-panel-expand-toggle").click();
    await page.waitForTimeout(800);
    await expect(page.locator(".details-panel-fields")).toBeHidden();
    const recollapsedBox = await panel.boundingBox();
    expect(Math.abs(recollapsedBox!.height - MOBILE_VIEWPORT.height / 3)).toBeLessThan(15);

    await page.locator(".details-panel-close-x").click();
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
    // Compact card anchored ~16px from the bottom-right corner, sized to
    // its content and capped well under the viewport height — not a
    // full-height sidebar (see FlightMap.css's .details-panel comment:
    // that used to paint directly over .tracked-chip, which shares the
    // same top-right corner).
    expect(box!.width).toBeLessThan(320);
    expect(Math.abs(box!.x + box!.width - (DESKTOP_VIEWPORT.width - 16))).toBeLessThan(5);
    expect(Math.abs(box!.y + box!.height - (DESKTOP_VIEWPORT.height - 16))).toBeLessThan(5);
    expect(box!.height).toBeLessThan(DESKTOP_VIEWPORT.height - 150);

    await page.screenshot({ path: "/tmp/desktop-layout-dossier-panel.png" });
  });
});
