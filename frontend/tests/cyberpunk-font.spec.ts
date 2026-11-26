import { expect, test, type Page } from "@playwright/test";
import { findMarkerNear, LIVE_FIXTURE, mockFlightApi, setMapView, waitForMapReady, waitForPlanes } from "./helpers";

// The cyberpunk theme uses one face (JetBrains Mono, self-hosted via
// @fontsource) for every piece of DOM text, form controls and map
// chrome (attribution, scale bar) included. MapLibre basemap labels are canvas glyphs, not DOM.

const target = LIVE_FIXTURE.find((p) => p.icao24 === "4aad15")!;

interface FontSample {
  what: string;
  tag: string;
  cls: string;
  fam: string;
}

interface FontSamples {
  samples: FontSample[];
  loaded: boolean;
}

// Runs in the page (serialised by page.evaluate), so it may only use what is
// defined inside it. Returns the computed font of every visible text node's
// parent and every visible form control.
async function sampleDomFonts(): Promise<FontSamples> {
  await document.fonts.ready;
  const samples: FontSample[] = [];
  const visible = (el: Element) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return [r.width > 0, r.height > 0, cs.visibility !== "hidden", cs.display !== "none"].every(Boolean);
  };
  const sample = (el: Element, what: string) => {
    if (!visible(el)) return;
    const tag = el.tagName.toLowerCase();
    samples.push({ what, tag, cls: el.getAttribute("class") ?? "", fam: getComputedStyle(el).fontFamily });
  };
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = n.textContent?.trim() ?? "";
    const el = text ? n.parentElement : null;
    if (el && !["SCRIPT", "STYLE"].includes(el.tagName)) sample(el, `text "${text.slice(0, 30)}"`);
  }
  document.querySelectorAll("input, button, select, textarea").forEach((el) => sample(el, "control"));
  return { samples, loaded: document.fonts.check('600 16px "JetBrains Mono"') };
}

function auditFonts({ samples, loaded }: FontSamples) {
  const bad = samples
    .filter((s) => !s.fam.replace(/["']/g, "").startsWith("JetBrains Mono"))
    .map((s) => `${s.what} <${s.tag} class="${s.cls}">: ${s.fam}`);
  return { bad, checked: samples.length, loaded };
}

/** Select the target plane and open the legend and favourites panels, so their text is on screen. */
async function showSelectedPlaneAndPanels(page: Page): Promise<void> {
  await setMapView(page, target.latitude, target.longitude, 11);
  await waitForPlanes(page);
  await page.waitForTimeout(500);
  await (await findMarkerNear(page, target.latitude, target.longitude)).click();
  await page.getByText(`ICAO24 ${target.icao24.toUpperCase()}`).waitFor({ timeout: 5_000 });

  const legendToggle = page.locator(".map-legend-toggle");
  if (await legendToggle.isVisible()) await legendToggle.click();
  await page.locator(".favorites-panel-toggle").click();
  await page.waitForTimeout(300);
}

test("cyberpunk theme renders all DOM text in JetBrains Mono, self-hosted", async ({ page }) => {
  await mockFlightApi(page);
  await page.goto("/");
  await waitForMapReady(page, 20_000);

  await showSelectedPlaneAndPanels(page);
  await page.screenshot({ path: process.env.FONT_SHOT ?? "test-results/cyberpunk-font.png" });

  const fonts = auditFonts(await page.evaluate(sampleDomFonts));

  expect(fonts.checked).toBeGreaterThan(20);
  expect(fonts.bad).toEqual([]);
  expect(fonts.loaded).toBe(true);
});
