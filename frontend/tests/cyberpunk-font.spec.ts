import { expect, test } from "@playwright/test";
import { findMarkerNear, LIVE_FIXTURE, mockFlightApi, setMapView, waitForPlanes } from "./helpers";

// The cyberpunk theme uses one face (JetBrains Mono, self-hosted via
// @fontsource) for every piece of DOM text, form controls and map
// chrome (attribution, scale bar) included. MapLibre basemap labels are canvas glyphs, not DOM.

const target = LIVE_FIXTURE.find((p) => p.icao24 === "4aad15")!;

test("cyberpunk theme renders all DOM text in JetBrains Mono, self-hosted", async ({ page }) => {
  await mockFlightApi(page);
  await page.goto("/");
  await page.waitForSelector(".map-container", { timeout: 20_000 });

  await setMapView(page, target.latitude, target.longitude, 11);
  await waitForPlanes(page);
  await page.waitForTimeout(500);
  await (await findMarkerNear(page, target.latitude, target.longitude)).click();
  await page.getByText(`ICAO24 ${target.icao24.toUpperCase()}`).waitFor({ timeout: 5_000 });

  const legendToggle = page.locator(".map-legend-toggle");
  if (await legendToggle.isVisible()) await legendToggle.click();
  await page.locator(".favorites-panel-toggle").click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: process.env.FONT_SHOT ?? "test-results/cyberpunk-font.png" });

  const fonts = await page.evaluate(async () => {
    await document.fonts.ready;
    const bad: string[] = [];
    let checked = 0;
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none";
    };
    const check = (el: Element, what: string) => {
      checked++;
      const fam = getComputedStyle(el).fontFamily;
      if (!fam.replace(/["']/g, "").startsWith("JetBrains Mono")) {
        bad.push(`${what} <${el.tagName.toLowerCase()} class="${el.getAttribute("class") ?? ""}">: ${fam}`);
      }
    };
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement;
      if (!el || !n.textContent?.trim() || ["SCRIPT", "STYLE"].includes(el.tagName)) continue;
      if (visible(el)) check(el, `text "${n.textContent.trim().slice(0, 30)}"`);
    }
    document.querySelectorAll("input, button, select, textarea").forEach((el) => {
      if (visible(el)) check(el, "control");
    });
    return { bad, checked, loaded: document.fonts.check('600 16px "JetBrains Mono"') };
  });

  expect(fonts.checked).toBeGreaterThan(20);
  expect(fonts.bad).toEqual([]);
  expect(fonts.loaded).toBe(true);
});
