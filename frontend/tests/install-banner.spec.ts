import { expect, test, type Page } from "@playwright/test";
import { mockFlightApi, waitForMapReady } from "./helpers";

// #123: the three QA should-fixes on the install pill. Everything here is
// measured as geometry — the size of a tap target is its *hit* area, not the
// paint, and the buttons reach 44px with ::after boxes that have no element
// of their own, so the hit area is probed with elementFromPoint rather than
// read from getBoundingClientRect. "Covers the attribution" is the
// intersection of the pill's box with MapLibre's own control boxes. No
// colour assertions: colour is already covered by the theme tests.

const PILL = ".install-banner";
const ACTION = ".install-banner-action";
const DISMISS = ".install-banner-dismiss";

test.describe.configure({ timeout: 180_000 });

async function showInstallPill(page: Page): Promise<void> {
  await mockFlightApi(page);
  await page.goto("/");
  await waitForMapReady(page, 30_000);
  // The event Chrome fires when the app is installable. A real
  // BeforeInstallPromptEvent cannot be constructed; the module only reads
  // preventDefault(), prompt() and userChoice (see pwa.spec.ts).
  await page.evaluate(() => {
    const event = new Event("beforeinstallprompt") as Event & {
      prompt: () => Promise<void>;
      userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
    };
    event.prompt = async () => {};
    event.userChoice = Promise.resolve({ outcome: "dismissed", platform: "web" });
    window.dispatchEvent(event);
  });
  await expect(page.locator(PILL)).toBeVisible();
}

/** Area of the intersection of two boxes; 0 when they do not touch. */
function intersection(a: { top: number; left: number; right: number; bottom: number }, b: { top: number; left: number; right: number; bottom: number }): number {
  const w = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
  const h = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  return w * h;
}

/**
 * The control's real hit area, found by walking outward from its centre in
 * 1px steps until elementFromPoint stops resolving to it. The ::after hit
 * boxes are not elements, so this is the only honest way to measure them.
 */
function hitArea(sel: string): { width: number; height: number; centre: { x: number; y: number } } | null {
  const el = document.querySelector(sel);
  if (!el) return null;
  const b = el.getBoundingClientRect();
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  const owns = (x: number, y: number): boolean => {
    const hit = document.elementFromPoint(x, y);
    return !!hit && (hit === el || el.contains(hit));
  };
  const reach = (dx: number, dy: number): number => {
    let d = 0;
    while (d < 200 && owns(cx + dx * d, cy + dy * d)) d += 1;
    return d - 1;
  };
  const left = reach(-1, 0);
  const right = reach(1, 0);
  const up = reach(0, -1);
  const down = reach(0, 1);
  return { width: left + right + 1, height: up + down + 1, centre: { x: cx, y: cy } };
}

/**
 * Resolves once MapLibre's attribution has stopped moving. The map runs a
 * short zoom on start-up; each frame resizes the scale bar and reflows the
 * attribution beside it, so a trial click issued too early never finds a
 * stable box. Two consecutive 100ms polls with the same rect is enough.
 */
async function waitForAttributionStable(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const a = document.querySelector(".maplibregl-ctrl-attrib-inner a");
      if (!a) return false;
      const b = a.getBoundingClientRect();
      const prev = (window as unknown as { __attribRect?: { x: number; y: number; w: number } }).__attribRect;
      (window as unknown as { __attribRect?: { x: number; y: number; w: number } }).__attribRect = { x: b.x, y: b.y, w: b.width };
      return !!prev && prev.x === b.x && prev.y === b.y && prev.w === b.width;
    },
    null,
    { timeout: 15_000, polling: 100 },
  );
}

test.describe("install pill polish (#123)", () => {
  test("each control owns at least a 44x44 tap area", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await showInstallPill(page);

    for (const sel of [ACTION, DISMISS]) {
      const area = await page.evaluate(hitArea, sel);
      expect(area, `${sel} not found`).not.toBeNull();
      expect(area!.width, `${sel} hit width`).toBeGreaterThanOrEqual(44);
      expect(area!.height, `${sel} hit height`).toBeGreaterThanOrEqual(44);
      // The painted button may stay smaller; only the hit area has to clear 44.
      expect(area!.centre.x).toBeGreaterThan(0);
      expect(area!.centre.y).toBeGreaterThan(0);
    }
  });

  test("the pill clears MapLibre's attribution and scale bar in portrait, landscape and standalone safe-area", async ({ page }) => {
    const cases = [
      { width: 390, height: 844, inset: 0, name: "390 portrait" },
      { width: 390, height: 844, inset: 34, name: "390 portrait, standalone home indicator" },
      { width: 844, height: 390, inset: 21, name: "390-class landscape, standalone" },
      { width: 1280, height: 800, inset: 0, name: "1280 desktop" },
    ] as const;

    for (const c of cases) {
      await page.setViewportSize({ width: c.width, height: c.height });
      if (c.inset) {
        const cdp = await page.context().newCDPSession(page);
        await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: 0, bottom: c.inset, left: 0, right: 0 } } as never);
      }
      await mockFlightApi(page);
      await page.goto("/");
      await waitForMapReady(page, 30_000);
      await page.evaluate(() => {
        const event = new Event("beforeinstallprompt") as Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };
        event.prompt = async () => {};
        event.userChoice = Promise.resolve({ outcome: "dismissed" });
        window.dispatchEvent(event);
      });
      await expect(page.locator(PILL)).toBeVisible();

      const geo = await page.evaluate(() => {
        const r = (sel: string) => {
          const el = document.querySelector(sel);
          if (!el) return null;
          const b = el.getBoundingClientRect();
          return { x: b.x, y: b.y, width: b.width, height: b.height, top: b.top, right: b.right, bottom: b.bottom, left: b.left };
        };
        const links = Array.from(document.querySelectorAll(".maplibregl-ctrl-attrib-inner a")).map((a) => {
          const b = a.getBoundingClientRect();
          return { href: (a as HTMLAnchorElement).href, width: b.width, height: b.height, top: b.top, right: b.right, bottom: b.bottom, left: b.left };
        });
        return { pill: r(".install-banner"), bl: r(".maplibregl-ctrl-bottom-left"), br: r(".maplibregl-ctrl-bottom-right"), links };
      });

      expect(geo.pill, c.name).not.toBeNull();
      expect(geo.bl, `${c.name}: scale bar control`).not.toBeNull();
      expect(geo.br, `${c.name}: attribution control`).not.toBeNull();
      expect(intersection(geo.pill!, geo.bl!), `${c.name}: pill covers the scale bar`).toBe(0);
      expect(intersection(geo.pill!, geo.br!), `${c.name}: pill covers the attribution`).toBe(0);

      expect(geo.links.length, `${c.name}: attribution links`).toBeGreaterThan(0);
      for (const link of geo.links) {
        expect(link.width, `${c.name}: ${link.href} width`).toBeGreaterThan(0);
        expect(link.height, `${c.name}: ${link.href} height`).toBeGreaterThan(0);
        // The pill must not cover the link's box either.
        expect(intersection(geo.pill!, link), `${c.name}: pill covers ${link.href}`).toBe(0);
      }
      // "Clickable" is the browser's own hit test, not elementFromPoint:
      // a trial click throws and names the element on top if anything
      // opaque covers the link. That is what a tap would actually hit.
      // Wait for the map's start-up zoom to stop first: while the scale bar
      // is still resizing, the attribution reflows every frame and Playwright
      // never sees the link as stable.
      await waitForAttributionStable(page);
      const anchors = page.locator(".maplibregl-ctrl-attrib-inner a");
      const anchorCount = await anchors.count();
      expect(anchorCount, `${c.name}: attribution anchors`).toBeGreaterThan(0);
      for (let i = 0; i < anchorCount; i += 1) {
        await expect(anchors.nth(i), `${c.name}: attribution link ${i} visible`).toBeVisible();
        await anchors.nth(i).click({ trial: true, timeout: 5_000 });
      }
    }
  });

  test("the pill's text is at least 14px at 390 and 1280", async ({ page }) => {
    for (const [width, height] of [[390, 844], [1280, 800]] as const) {
      await page.setViewportSize({ width, height });
      await showInstallPill(page);
      const sizes = await page.evaluate(() => {
        const size = (sel: string) => {
          const el = document.querySelector(sel);
          return el ? parseFloat(getComputedStyle(el).fontSize) : null;
        };
        return { pill: size(".install-banner"), text: size(".install-banner-text"), action: size(".install-banner-action"), dismiss: size(".install-banner-dismiss") };
      });
      for (const [name, value] of Object.entries(sizes)) {
        expect(value, `${name} at ${width}px`).not.toBeNull();
        expect(value!, `${name} at ${width}px`).toBeGreaterThanOrEqual(14);
      }
    }
  });
});
