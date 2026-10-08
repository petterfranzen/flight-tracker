import { expect, test } from "@playwright/test";
import { findMarkerNear, LIVE_FIXTURE, mockFlightApi, setMapView, waitForPlanes } from "./helpers";

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
    await page.waitForSelector(".map-container", { timeout: 10_000 });

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

  test("text inputs are >= 16px so iOS Safari does not zoom on focus, and pinch-zoom stays enabled", async ({ page }) => {
    await page.setViewportSize(MOBILE_VIEWPORT);
    await mockFlightApi(page);
    await page.goto("/");
    await page.waitForSelector(".map-container", { timeout: 10_000 });

    // Blocking zoom via the viewport meta would "fix" this at the cost of accessibility.
    const viewport = await page.locator('meta[name="viewport"]').getAttribute("content");
    expect(viewport).not.toBeNull();
    expect(viewport).not.toMatch(/maximum-scale/i);
    expect(viewport).not.toMatch(/user-scalable\s*=\s*(no|0)/i);

    await page.locator(".flight-search-fab").click();
    await expect(page.locator(".flight-search-airport-input")).toBeVisible();

    const sizes = await page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLElement>("input, textarea, select"))
        .filter((el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden")
        .map((el) => ({ cls: el.className, size: parseFloat(getComputedStyle(el).fontSize) })),
    );
    expect(sizes.length).toBeGreaterThanOrEqual(2);
    for (const { cls, size } of sizes) {
      expect(size, `font-size of input "${cls}"`).toBeGreaterThanOrEqual(16);
    }
  });

  test("selecting a favorite closes the favorites drawer, and the sheet's expand arrow sits at its top", async ({ page }) => {
    await page.setViewportSize(MOBILE_VIEWPORT);
    await mockFlightApi(page);
    await page.goto("/");
    await page.waitForSelector(".map-container", { timeout: 10_000 });

    const target = LIVE_FIXTURE.find((p) => p.icao24 === "4aad15")!;
    await setMapView(page, target.latitude, target.longitude, 11);
    await waitForPlanes(page);
    await page.waitForTimeout(500);
    await (await findMarkerNear(page, target.latitude, target.longitude)).click();
    await page.getByText(`ICAO24 ${target.icao24.toUpperCase()}`).waitFor({ state: "attached", timeout: 2_000 });
    // The favourite buttons live in the expanded sheet; the collapsed one is a short peek.
    await page.locator(".details-panel-expand-toggle").click();
    await page.getByRole("button", { name: "Favorite this aircraft", exact: true }).click();
    await page.locator(".details-panel-close-x").click();
    await expect(page.locator(".details-panel")).toHaveCount(0);

    await page.locator(".favorites-panel-fab").click();
    const body = page.locator(".favorites-panel-body");
    await expect(body).toHaveClass(/favorites-panel-body--open/);
    const item = page.locator(".favorites-panel-item", { hasText: target.callsign! });
    await expect(item.locator(".favorites-panel-item-status")).toHaveText("live now", { timeout: 5_000 });
    await item.locator(".favorites-panel-item-select").click();

    // Drawer closes by itself so the selected plane is visible.
    await expect(body).not.toHaveClass(/favorites-panel-body--open/);
    await expect(page.locator(".details-panel")).toBeVisible();

    // Expand arrow is at the top of the sheet, above the heading.
    // Read all three rects in one evaluate: the panel is rebuilt on position
    // updates, so separate locator lookups can land on a detached node.
    await expect(page.locator(".details-panel h2")).toBeVisible();
    const rects = await page.evaluate(() => {
      const r = (sel: string) => document.querySelector(sel)!.getBoundingClientRect();
      const panel = r(".details-panel");
      const toggle = r(".details-panel-expand-toggle");
      const heading = r(".details-panel h2");
      return { toggleTop: toggle.top - panel.top, toggleBottom: toggle.bottom, headingTop: heading.top };
    });
    expect(rects.toggleTop).toBeLessThan(10);
    expect(rects.toggleBottom).toBeLessThanOrEqual(rects.headingTop + 1);
  });

  test("sheet sizing tracks the visible viewport (dvh) and the expand arrow is a real touch target", async ({ page }) => {
    await page.setViewportSize(MOBILE_VIEWPORT);
    await mockFlightApi(page);
    await page.goto("/");
    await page.waitForSelector(".map-container", { timeout: 10_000 });

    // Chromium's dvh equals vh, so this can't be observed by measuring: on iOS
    // Safari 100vh is the viewport with toolbars collapsed, which pushes the
    // bottom of the sheet under the toolbar. Guard the rules themselves.
    const usesDvh = await page.evaluate(() => {
      const found = new Set<string>();
      const walk = (rules: CSSRuleList) => {
        for (const rule of Array.from(rules)) {
          if (rule instanceof CSSStyleRule && /dvh/.test(rule.style.cssText)) found.add(rule.selectorText);
          else if ("cssRules" in rule) walk((rule as CSSGroupingRule).cssRules);
        }
      };
      for (const sheet of Array.from(document.styleSheets)) {
        try {
          walk(sheet.cssRules);
        } catch {
          /* cross-origin sheet */
        }
      }
      return Array.from(found);
    });
    expect(usesDvh).toContain(".app-shell");
    expect(usesDvh).toContain(".details-panel");
    expect(usesDvh).toContain(".details-panel--expanded");

    const target = LIVE_FIXTURE.find((p) => p.icao24 === "4aad15")!;
    await setMapView(page, target.latitude, target.longitude, 11);
    await waitForPlanes(page);
    await page.waitForTimeout(500);
    await (await findMarkerNear(page, target.latitude, target.longitude)).click();
    await expect(page.locator(".details-panel-expand-toggle")).toBeVisible();
    // Polled: the panel re-renders as the selection's data arrives, and a
    // read that lands on a just-replaced element measures 0.
    await expect.poll(() => page.locator(".details-panel-expand-toggle").evaluate((el) => el.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
  });

  test("expand arrow points the way the sheet will move, and the expanded sheet shows the whole dossier without scrolling", async ({ page }) => {
    await page.setViewportSize(MOBILE_VIEWPORT);
    await mockFlightApi(page);
    await page.route("**/api/aircraft/4aad15*", (route) =>
      route.fulfill({
        json: {
          icao24: "4aad15",
          registration: "TC-RSC",
          model: "Bombardier Learjet 45 XR",
          operator: "Redstar Aviation",
          originAirport: "LEAL",
          originAirportName: "Alicante-Elche Miguel Hernández Airport",
          originAirportIata: "ALC",
          destinationAirport: "ESSA",
          destinationAirportName: "Stockholm Arlanda Airport",
          destinationAirportIata: "ARN",
          flightMinutes: 135,
          etaMinutes: 20,
          cruisingAltitudeM: 13106,
          flightPhase: "DESCENDING",
          staleExplanation: null,
          legStartAt: null,
        },
      }),
    );
    await page.goto("/");
    await page.waitForSelector(".map-container", { timeout: 10_000 });
    const target = LIVE_FIXTURE.find((p) => p.icao24 === "4aad15")!;
    await setMapView(page, target.latitude, target.longitude, 11);
    await waitForPlanes(page);
    await page.waitForTimeout(500);
    await (await findMarkerNear(page, target.latitude, target.longitude)).click();
    await page.getByText("ICAO24 4AAD15").waitFor({ state: "attached", timeout: 5_000 });
    await expect(page.locator(".details-panel-field", { hasText: "Registration" })).toContainText("TC-RSC", { timeout: 5_000 });

    // Bottom-sheet convention: collapsed shows an up arrow (pull up to expand),
    // expanded shows a down arrow (push down to collapse).
    const toggle = page.locator(".details-panel-expand-toggle");
    await expect(toggle).toHaveText("▲");
    await expect(toggle).toHaveAttribute("aria-label", "Show more");
    await toggle.click();
    await expect(toggle).toHaveText("▼");
    await expect(toggle).toHaveAttribute("aria-label", "Show less");
    await page.waitForTimeout(500);

    const m = await page.evaluate(() => {
      const inner = document.querySelector(".details-panel-inner")!;
      const top = (label: string) => {
        const dt = Array.from(document.querySelectorAll(".details-panel-fields dt")).find((e) => e.textContent === label)!;
        return dt.getBoundingClientRect().top;
      };
      return { overflow: inner.scrollHeight - inner.clientHeight, regTop: top("Registration"), typeTop: top("Type"), originTop: top("Origin"), destTop: top("Destination") };
    });
    expect(m.overflow, "expanded sheet needs no scrolling").toBeLessThanOrEqual(1);
    expect(Math.abs(m.regTop - m.typeTop), "Type and Registration share a row").toBeLessThan(2);
    expect(m.destTop, "long Origin/Destination get their own rows").toBeGreaterThan(m.originTop);
  });

  test("map attribution is compact on mobile", async ({ page }) => {
    await page.setViewportSize(MOBILE_VIEWPORT);
    await mockFlightApi(page);
    await page.goto("/");
    await page.waitForSelector(".map-container", { timeout: 10_000 });
    const attribution = page.locator(".maplibregl-ctrl-attrib");
    await expect(attribution).toBeVisible();
    await expect(attribution).not.toContainText("MapLibre"); // the library credit is dropped on phones; the data credits stay
    await expect(attribution).toContainText("OpenStreetMap");
    const fontSize = await attribution.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(fontSize).toBeLessThanOrEqual(10);
    expect((await attribution.boundingBox())!.width).toBeLessThanOrEqual(MOBILE_VIEWPORT.width * 0.6 + 1);
  });

  test("selecting an aircraft opens the dossier as a bottom sheet, not a side panel", async ({ page }) => {
    await page.setViewportSize(MOBILE_VIEWPORT);
    await mockFlightApi(page);
    await page.goto("/");
    await page.waitForSelector(".map-container", { timeout: 10_000 });

    const target = LIVE_FIXTURE.find((p) => p.icao24 === "4aad15")!;
    await setMapView(page, target.latitude, target.longitude, 11);
    await waitForPlanes(page);
    await page.waitForTimeout(500);

    const marker = await findMarkerNear(page, target.latitude, target.longitude);
    await marker.click();
    await page.waitForTimeout(900); // flyTo's own 800ms animation + resize/reflow

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
    // Collapsed default: a short peek (handle, callsign, last update) so the
    // map keeps most of the screen, not the old third of it.
    expect(box!.height).toBeLessThanOrEqual(MOBILE_VIEWPORT.height * 0.22);
    await expect(page.locator(".details-panel h2")).toBeVisible();
    await expect(page.locator(".details-panel-updated")).toBeVisible();
    await expect(page.locator(".details-panel-fields")).toBeHidden();
    for (const secondary of [".details-panel-eyebrow", ".details-panel-favorite-toggles", ".details-panel-meta--secondary"]) {
      await expect(page.locator(secondary), `${secondary} waits for the expanded sheet`).toBeHidden();
    }

    // The actual regression this whole fix is for: the selected plane must
    // sit above the sheet, not underneath it (the old absolute-overlay
    // sheet left the map at full height, so flyTo centered the marker at
    // the *container's* true center — right behind the sheet).
    const collapsedMarker = await findMarkerNear(page, target.latitude, target.longitude);
    const collapsedMarkerBox = await collapsedMarker.boundingBox();
    expect(collapsedMarkerBox).not.toBeNull();
    expect(collapsedMarkerBox!.y + collapsedMarkerBox!.height).toBeLessThan(box!.y);

    await page.screenshot({ path: "/tmp/mobile-layout-dossier-collapsed.png" });

    // Expand: sheet grows to fit its content, map shrinks, plane re-centers
    // within that smaller area and must still clear the (now much taller) sheet.
    await page.locator(".details-panel-expand-toggle").click();
    await page.waitForTimeout(800); // CSS height transition (250ms) + panTo's 500ms
    await expect(page.locator(".details-panel-fields")).toBeVisible();
    await expect(page.locator(".details-panel-favorite-toggles")).toBeVisible();
    const expandedBox = await panel.boundingBox();
    // Content-sized, between the collapsed third and the 78% cap.
    expect(expandedBox!.height).toBeGreaterThan(box!.height);
    expect(expandedBox!.height).toBeLessThanOrEqual(MOBILE_VIEWPORT.height * 0.78 + 1);

    const expandedMarker = await findMarkerNear(page, target.latitude, target.longitude);
    const expandedMarkerBox = await expandedMarker.boundingBox();
    expect(expandedMarkerBox).not.toBeNull();
    expect(expandedMarkerBox!.y + expandedMarkerBox!.height).toBeLessThan(expandedBox!.y);

    await page.screenshot({ path: "/tmp/mobile-layout-dossier-expanded.png" });

    // Collapse back: height and marker position both return to the peek.
    await page.locator(".details-panel-expand-toggle").click();
    await page.waitForTimeout(800);
    await expect(page.locator(".details-panel-fields")).toBeHidden();
    const recollapsedBox = await panel.boundingBox();
    expect(Math.abs(recollapsedBox!.height - box!.height)).toBeLessThan(2);

    await page.locator(".details-panel-close-x").click();
    await expect(panel).toBeHidden();
  });

  test("desktop layout is unchanged: header, inline search, and side-panel dossier", async ({ page }) => {
    await page.setViewportSize(DESKTOP_VIEWPORT);
    await mockFlightApi(page);
    await page.goto("/");
    await page.waitForSelector(".map-container", { timeout: 10_000 });

    await expect(page.locator(".app-header")).toBeVisible();
    await expect(page.locator(".flight-search-fab")).toBeHidden();
    await expect(page.locator(".flight-search-input").first()).toBeVisible();

    const target = LIVE_FIXTURE.find((p) => p.icao24 === "4aad15")!;
    await setMapView(page, target.latitude, target.longitude, 11);
    await waitForPlanes(page);
    await page.waitForTimeout(500);
    const marker = await findMarkerNear(page, target.latitude, target.longitude);
    await marker.click();

    const panel = page.locator(".details-panel");
    await expect(panel).toBeVisible();
    const box = await panel.boundingBox();
    expect(box).not.toBeNull();
    // Compact card anchored ~16px from the right edge, vertically
    // centered, sized to its content and capped well under the viewport
    // height — not a full-height sidebar (see FlightMap.css's
    // .details-panel comment: that used to paint directly over
    // .tracked-chip, which shares the same top-right corner).
    expect(box!.width).toBeLessThan(320);
    expect(Math.abs(box!.x + box!.width - (DESKTOP_VIEWPORT.width - 16))).toBeLessThan(5);
    const verticalCenter = box!.y + box!.height / 2;
    expect(Math.abs(verticalCenter - DESKTOP_VIEWPORT.height / 2)).toBeLessThan(5);
    expect(box!.height).toBeLessThan(DESKTOP_VIEWPORT.height - 150);

    await page.screenshot({ path: "/tmp/desktop-layout-dossier-panel.png" });
  });
});
