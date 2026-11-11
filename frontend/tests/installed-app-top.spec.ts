import { expect, test, type Page } from "@playwright/test";
import { mockFlightApi, waitForMapReady } from "./helpers";

// section9-hq#287: the installed (Home Screen) app runs the map edge to edge
// again, under the translucent iOS status bar, with iOS 26.1+'s dark scrim over
// that strip. That is fine as long as nothing active is faded out by the scrim:
// the map canvas starts at y=0, and every control / text element pinned to the
// top clears the scrim by at least the safe-area inset + 16px.
//
// The earlier #277 fix removed `apple-mobile-web-app-status-bar-style:
// black-translucent`, which dropped the status bar to opaque and pushed the page
// below it (no map under the bar). #287 restores the meta and moves the chrome
// down instead, via the shared --safe-top token.
//
// Playwright cannot emulate the iOS status bar itself, but it can emulate the
// safe-area insets the app lays out against (CDP
// Emulation.setSafeAreaInsetsOverride) and the installed-app class the app sets
// from navigator.standalone. This guards the DOM half of the fix.

const IPHONE = { width: 393, height: 852 }; // iPhone 15/16 logical size
const TOP_INSET = 59; // status-bar height in installed-app emulation
const BOTTOM_INSET = 34;
// The scrim fades a little below the status bar, so nothing active may have its
// top inside [0, inset + 16).
const CLEAR = TOP_INSET + 16;

// Chrome that must clear the scrim, whether or not it is currently open.
const TOP_CHROME = [".app-header", ".tracked-chip", ".left-overlay-stack", ".left-overlay-stack > *", ".control-panel"];

// Anything the user can tap or type into.
const INTERACTIVE = "button, input, select, textarea, a[href], [role='button']";

async function installedApp(page: Page): Promise<void> {
  await page.setViewportSize(IPHONE);
  // isStandalone() reads navigator.standalone on iOS; set it before boot so
  // applyStandaloneViewport adds html.standalone exactly as on a phone.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "standalone", { get: () => true });
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setSafeAreaInsetsOverride", {
    insets: { top: TOP_INSET, bottom: BOTTOM_INSET, left: 0, right: 0 },
  } as never);
  await mockFlightApi(page);
  await page.goto("/");
  await waitForMapReady(page, 30_000);
  // The boot screen covers the whole viewport until the first load and the
  // basemap are in; it fades (boot-screen--hidden) and is then removed. Probe
  // the top strip only once it is gone, or it is the boot screen we measure.
  await page.locator(".boot-screen").waitFor({ state: "detached", timeout: 30_000 });
}

test.describe("installed app: map edge to edge, controls clear of the status-bar scrim", () => {
  test.describe.configure({ timeout: 120_000 });

  test("the map canvas starts at y=0 and nothing active sits in the scrim strip", async ({ page }) => {
    await installedApp(page);

    const report = await page.evaluate(
      ({ chrome, interactive, clear }) => {
        const visible = (el: Element): boolean => {
          const cs = getComputedStyle(el);
          if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) <= 0) return false;
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        };
        const box = (el: Element | null) => {
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { top: r.top, left: r.left, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
        };

        const chromeRows: { sel: string; cls: string; top: number }[] = [];
        for (const sel of chrome) {
          for (const el of Array.from(document.querySelectorAll(sel))) {
            if (!visible(el)) continue;
            chromeRows.push({ sel, cls: typeof el.className === "string" ? el.className : "", top: el.getBoundingClientRect().top });
          }
        }

        const interactiveRows: { tag: string; cls: string; name: string; top: number }[] = [];
        for (const el of Array.from(document.querySelectorAll(interactive))) {
          if (!visible(el)) continue;
          interactiveRows.push({
            tag: el.tagName,
            cls: typeof el.className === "string" ? el.className : "",
            name: el.getAttribute("aria-label") ?? (el.textContent ?? "").trim().slice(0, 40),
            top: el.getBoundingClientRect().top,
          });
        }

        // Walk the strip: the topmost element there must be the map, never a
        // control or panel.
        const offenders: { x: number; y: number; tag: string; cls: string }[] = [];
        const hitSel = `${interactive}, .control-panel, .tracked-chip, .app-header, .left-overlay-stack`;
        for (const x of [20, Math.round(window.innerWidth / 2), window.innerWidth - 20]) {
          for (let y = 0; y < clear; y += 8) {
            const el = document.elementFromPoint(x, y) as HTMLElement | null;
            const hit = el?.closest(hitSel);
            if (hit) offenders.push({ x, y, tag: el!.tagName, cls: typeof el!.className === "string" ? el!.className : "" });
          }
        }

        return {
          innerHeight: window.innerHeight,
          innerWidth: window.innerWidth,
          canvas: box(document.querySelector(".map-container canvas")),
          shell: box(document.querySelector(".app-shell")),
          chromeRows,
          interactiveRows,
          offenders,
        };
      },
      { chrome: TOP_CHROME, interactive: INTERACTIVE, clear: CLEAR },
    );

    // The map runs to the very top and the very bottom of the viewport.
    expect(report.canvas).not.toBeNull();
    expect(report.canvas!.top).toBe(0);
    expect(report.canvas!.left).toBe(0);
    expect(report.canvas!.width).toBe(report.innerWidth);
    expect(report.canvas!.bottom).toBe(report.innerHeight);

    // The shell still fills the viewport (#201): no band at the bottom either.
    expect(report.shell).not.toBeNull();
    expect(report.shell!.top).toBe(0);
    expect(report.shell!.bottom).toBe(report.innerHeight);

    // Every top-pinned control and text panel clears the scrim.
    for (const row of report.chromeRows) {
      expect(row.top, `${row.sel} ${row.cls} top`).toBeGreaterThanOrEqual(CLEAR);
    }
    // ...and so does every visible button, input and link.
    for (const row of report.interactiveRows) {
      expect(row.top, `${row.tag} ${row.cls} "${row.name}" top`).toBeGreaterThanOrEqual(CLEAR);
    }
    // Nothing interactive or panel-like is in the faded strip at all.
    expect(report.offenders, `elements in [0, ${CLEAR}): ${JSON.stringify(report.offenders)}`).toEqual([]);
  });

  test("every open control panel clears the scrim", async ({ page }) => {
    await installedApp(page);

    const panels: { button: string; panel: string }[] = [
      { button: ".flight-search-fab", panel: "#flight-search-panel" },
      { button: ".favorites-panel-fab", panel: "#favorites-panel-body" },
      { button: ".watch-panel-toggle", panel: ".watch-panel-content" },
      { button: ".map-legend-fab", panel: "#map-legend-body" },
    ];

    for (const { button, panel } of panels) {
      await page.locator(button).click();
      const open = page.locator(`${panel}.control-panel--open`);
      await expect(open, `${panel} did not open`).toBeVisible();
      const box = await open.boundingBox();
      expect(box, `${panel} has no box`).not.toBeNull();
      expect(box!.y, `${panel} top`).toBeGreaterThanOrEqual(CLEAR);
    }
  });
});
