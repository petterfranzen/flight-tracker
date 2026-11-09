import { expect, test, type Page } from "@playwright/test";
import { findMarkerNear, freezeClock, LIVE_FIXTURE, mockFlightApi, seedWatched, setMapView, waitForMapReady, waitForPlanes, withMap } from "./helpers";

/**
 * Phone accessibility pass (section9-hq#182): accessible names and roles, the
 * 44x44 house tap-target minimum at 390x844 and 360x740, modal focus traps with
 * Escape and focus return, and prefers-reduced-motion for the map camera.
 *
 * Everything here drives the real DOM the way a user does (keyboard and taps)
 * and asserts measured geometry. The install pill is raised by dispatching the
 * beforeinstallprompt event headless Chromium never sends. The one thing that
 * cannot be raised on demand is the departure toast — it needs a watched flight
 * to leave the ground — so its buttons' declared 44px minimum is asserted from
 * computed style instead of a live hit test.
 */

// Opening six panels and a map selection in one test is more work than the
// repo's 30 s default allows on a loaded runner.
test.describe.configure({ timeout: 120_000 });

const PHONE = { width: 390, height: 844 };
const SMALL_PHONE = { width: 360, height: 740 };

const SCHEDULE_ROW = {
  flightNumber: "SK528",
  direction: "departures",
  scheduled: "2026-11-07T10:00:00Z",
  estimated: "2026-11-07T10:05:00Z",
  gate: "A12",
  status: "On time",
  airport: "ARN",
  departureIata: "ARN",
  arrivalIata: "LHR",
  airborne: false,
  icao24: null,
};

/**
 * A control clears the house minimum when both hold:
 *  - its own box measures at least `need` on both axes, and
 *  - the four points half a target out along its axes actually hit the control
 *    (or a descendant of it) rather than something over the top.
 *
 * The axis points rather than the corners: a round 48px icon button contains a
 * 44px-tall and a 44px-wide span, but its box has no 44px square inside it
 * (the corner of that square falls outside the circle), and border-radius
 * clips hit-testing. Returns one line per failing element.
 */
async function undersizedTargets(page: Page, selector: string, need = 44): Promise<string[]> {
  return page.$$eval(
    selector,
    (els, need) => {
      const bad: string[] = [];
      const half = need / 2 - 0.5;
      for (const el of els) {
        const h = el as HTMLElement;
        const r = h.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue; // hidden — not on the phone screen at all
        const cx = (r.left + r.right) / 2;
        const cy = (r.top + r.bottom) / 2;
        const pts: [number, number][] = [
          [cx - half, cy],
          [cx + half, cy],
          [cx, cy - half],
          [cx, cy + half],
        ];
        const hit = pts.every(([x, y]) => {
          if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) return false;
          const t = document.elementFromPoint(x, y);
          return t != null && (t === h || h.contains(t));
        });
        const size = r.width >= need - 0.5 && r.height >= need - 0.5;
        if (!(hit && size)) bad.push(`${h.className || h.tagName} is ${Math.round(r.width)}x${Math.round(r.height)} (hit=${hit})`);
      }
      return bad;
    },
    need,
  );
}

/**
 * The boot screen is a full-viewport overlay at z-index 1000, above the chrome
 * (z-index 500), so anything measured or clicked before it clears is measured
 * behind it. `waitForMapReady` only says the opening view request went out; the
 * boot screen stays until the basemap reports ready, a different (and on a fast
 * runner later) moment. Same wait helpers.clickAt() already uses.
 */
async function waitForChrome(page: Page): Promise<void> {
  await page.locator(".boot-screen:not(.boot-screen--hidden)").waitFor({ state: "detached", timeout: 20_000 });
}

async function seedFavorites(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem(
      "flighttracker:favoriteAircraft",
      JSON.stringify([{ icao24: "4aad15", registration: "TC-RSC", callsign: "WZZ1" }]),
    );
  });
}

/**
 * Every element that must clear the house minimum once a panel is open. Each
 * match is scrolled inside its own scroll box first: the watch list lives in a
 * 320px-tall scroll box, so its last row is below the fold and hit-testing it
 * there would measure the clip, not the control. `scrollIntoView({block:
 * "nearest"})` scrolls the scrollable ancestor; the Playwright helper skips it
 * because the element is already inside the viewport rect.
 */
async function expectTargets(page: Page, selectors: string[]): Promise<void> {
  const problems: string[] = [];
  for (const sel of selectors) {
    const loc = page.locator(sel);
    for (let i = 0, n = await loc.count(); i < n; i++) {
      await loc.nth(i).evaluate((el) => (el as HTMLElement).scrollIntoView({ block: "nearest" })).catch(() => {});
    }
    const bad = await undersizedTargets(page, sel);
    problems.push(...bad.map((b) => `${sel}: ${b}`));
  }
  expect(problems, problems.join("; ")).toEqual([]);
}

test.describe("phone accessibility", () => {
  test("every control reached by keyboard is named and shows the token focus ring", async ({ page }) => {
    await page.setViewportSize(PHONE);
    await mockFlightApi(page);
    await page.goto("/");
    await waitForMapReady(page, 60_000);
    await waitForChrome(page);

    // Icon-only controls carry an explicit accessible name.
    for (const name of ["Search flights", "Favorites", "Legend", "Watch flights"]) {
      await expect(page.getByRole("button", { name, exact: true })).toBeVisible();
    }

    // Tab through the phone chrome: every stop must be a real control with the
    // 3px --color-focus ring (no stop may fall back to a browser default).
    const stops: { tag: string; cls: string; outlineWidth: string; outlineStyle: string }[] = [];
    for (let i = 0; i < 14; i++) {
      await page.keyboard.press("Tab");
      const stop = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el || el === document.body) return null;
        const s = getComputedStyle(el);
        return { tag: el.tagName, cls: String(el.className).slice(0, 60), outlineWidth: s.outlineWidth, outlineStyle: s.outlineStyle };
      });
      if (stop) stops.push(stop);
    }
    expect(stops.length, "keyboard reached several controls").toBeGreaterThanOrEqual(4);
    const noRing = stops.filter((s) => s.outlineStyle !== "solid" || s.outlineWidth !== "3px");
    expect(noRing, `no focus ring: ${JSON.stringify(noRing)}`).toEqual([]);
  });

  test("the phone overlays are modal dialogs: focus moves in, Tab is trapped, Escape closes and returns focus", async ({ page }) => {
    await page.setViewportSize(PHONE);
    await mockFlightApi(page);
    await page.goto("/");
    await waitForMapReady(page, 60_000);
    await waitForChrome(page);

    const inside = (sel: string) =>
      page.evaluate((s) => !!document.querySelector(s)?.contains(document.activeElement), sel);
    const activeClass = () => page.evaluate(() => String((document.activeElement as HTMLElement | null)?.className ?? ""));

    // --- search ---
    await page.locator(".flight-search-fab").click();
    const searchPanel = page.locator(".flight-search-panel");
    await expect(searchPanel).toHaveAttribute("role", "dialog");
    await expect(searchPanel).toHaveAttribute("aria-modal", "true");
    await expect.poll(() => inside(".flight-search-panel")).toBe(true);
    for (let i = 0; i < 4; i++) await page.keyboard.press("Tab");
    expect(await inside(".flight-search-panel"), "Tab stays in the search overlay").toBe(true);
    await page.keyboard.press("Escape");
    await expect(searchPanel).not.toHaveClass(/flight-search-panel--open/);
    await expect.poll(activeClass).toContain("flight-search-fab");

    // --- favorites ---
    await page.locator(".favorites-panel-fab").click();
    const favBody = page.locator(".favorites-panel-body");
    await expect(favBody).toHaveAttribute("role", "dialog");
    await expect(favBody).toHaveAttribute("aria-modal", "true");
    await expect.poll(() => inside(".favorites-panel-body")).toBe(true);
    for (let i = 0; i < 4; i++) await page.keyboard.press("Tab");
    expect(await inside(".favorites-panel-body"), "Tab stays in the favorites drawer").toBe(true);
    await page.keyboard.press("Escape");
    await expect(favBody).not.toHaveClass(/favorites-panel-body--open/);
    await expect.poll(activeClass).toContain("favorites-panel-fab");

    // --- legend ---
    await page.locator(".map-legend-fab").click();
    const legendBody = page.locator(".map-legend-body");
    await expect(legendBody).toHaveAttribute("role", "dialog");
    await expect(legendBody).toHaveAttribute("aria-modal", "true");
    await expect.poll(() => inside(".map-legend-body")).toBe(true);
    await page.keyboard.press("Escape");
    await expect(legendBody).not.toHaveClass(/map-legend-body--open/);
    await expect.poll(activeClass).toContain("map-legend-fab");
  });

  test("tap targets clear 44x44 at 390x844: chrome, search, favorites, watch stop, legend rows, dossier", async ({ page }) => {
    await page.setViewportSize(PHONE);
    await seedWatched(page, [{ flightNumber: "SK528", date: "2026-11-07", airport: "ARN", label: "ARN → LHR" }]);
    await seedFavorites(page);
    await mockFlightApi(page);
    await page.route("**/api/schedule/search*", (route) => route.fulfill({ json: [SCHEDULE_ROW] }));
    await page.goto("/");
    await waitForMapReady(page, 60_000);
    await waitForChrome(page);

    // Collapsed chrome. (The bottom dock is deliberately display:none on a
    // phone — see Dock.css — so it is not on the phone's hit map at all.)
    await expect(page.locator(".dock-wrap")).toBeHidden();
    await expectTargets(page, [".flight-search-fab", ".favorites-panel-fab", ".watch-panel-toggle", ".map-legend-fab"]);

    // Install pill: headless Chromium never fires beforeinstallprompt, so raise
    // it by hand — the same event the browser would send — and measure both
    // controls.
    await page.evaluate(() => {
      const e = new Event("beforeinstallprompt");
      Object.assign(e, { prompt: () => Promise.resolve(), userChoice: Promise.resolve({ outcome: "dismissed", platform: "web" }) });
      window.dispatchEvent(e);
    });
    await expect(page.locator(".install-banner")).toBeVisible();
    await expectTargets(page, [".install-banner-action", ".install-banner-dismiss"]);
    await page.locator(".install-banner-dismiss").click();
    await expect(page.locator(".install-banner")).toHaveCount(0);

    // Search overlay: close button, both fields, the watched chip.
    await page.locator(".flight-search-fab").click();
    await expect(page.locator(".flight-search-input").first()).toBeVisible();
    await expectTargets(page, [".flight-search-panel-close", ".flight-search-input", ".flight-search-chip"]);
    await page.keyboard.press("Escape");

    // Favorites drawer: close, the row's select and its remove ✕.
    await page.locator(".favorites-panel-fab").click();
    await expect(page.locator(".favorites-panel-item")).toHaveCount(1);
    await expectTargets(page, [".favorites-panel-body-close", ".favorites-panel-item-select", ".favorites-panel-item-remove"]);
    await page.keyboard.press("Escape");

    // Watch panel: search button, the stop-watching ✕, and the result's Watch.
    await page.locator(".watch-panel-toggle").click();
    await page.locator(".watch-panel-flight").fill("SK528");
    await page.locator(".watch-panel-search").click();
    await expect(page.locator(".watch-panel-watch")).toBeVisible({ timeout: 5_000 });
    await expectTargets(page, [".watch-panel-search", ".watch-panel-watch", ".watch-panel-remove"]);
    await page.keyboard.press("Escape");

    // Legend: close button and every swatch row.
    await page.locator(".map-legend-fab").click();
    await expect(page.locator(".map-legend-row")).toHaveCount(4);
    await expectTargets(page, [".map-legend-body-close", ".map-legend-row"]);
    await page.keyboard.press("Escape");

    // Dossier bottom sheet: the ✕, the expand handle, the favourite toggles.
    const target = LIVE_FIXTURE.find((p) => p.icao24 === "4aad15")!;
    await setMapView(page, target.latitude, target.longitude, 11);
    await waitForPlanes(page, 1, 60_000);
    await (await findMarkerNear(page, target.latitude, target.longitude)).click();
    await expect(page.locator(".details-panel")).toBeVisible();
    // The sheet is re-rendered as the selection's dossier arrives; wait for the
    // dossier line to exist (the same gate the repo's own mobile-layout spec
    // uses) before clicking into it, or the click races a rebuild and never
    // lands.
    await page.getByText(`ICAO24 ${target.icao24.toUpperCase()}`).waitFor({ state: "attached", timeout: 10_000 });
    await page.locator(".details-panel-expand-toggle").click({ timeout: 15_000 });
    await expect(page.locator(".details-panel-favorite-toggles")).toBeVisible();
    await expectTargets(page, [".details-panel-close-x", ".details-panel-expand-toggle", ".details-panel-favorite-toggle"]);

    // Declared minimums for the one control that cannot be raised on demand
    // (see the file header): the departure toast's two buttons.
    const declared = await page.evaluate(() => {
      const out: Record<string, string> = {};
      for (const cls of ["watch-toast-go", "watch-toast-close"]) {
        const probe = document.createElement("button");
        probe.className = cls;
        document.body.appendChild(probe);
        const s = getComputedStyle(probe);
        out[cls] = `${s.minWidth} x ${s.minHeight}`;
        probe.remove();
      }
      return out;
    });
    expect(declared["watch-toast-go"]).toBe("44px x 44px");
    expect(declared["watch-toast-close"]).toBe("44px x 44px");
  });

  test("the Watch stop button and the legend rows clear 44x44 at 360x740 too", async ({ page }) => {
    await page.setViewportSize(SMALL_PHONE);
    await seedWatched(page, [{ flightNumber: "SK528", date: "2026-11-07", airport: "ARN", label: "ARN → LHR" }]);
    await mockFlightApi(page);
    await page.goto("/");
    await waitForMapReady(page, 60_000);
    await waitForChrome(page);

    await page.locator(".watch-panel-toggle").click();
    await expect(page.locator(".watch-panel-remove")).toBeVisible();
    await expectTargets(page, [".watch-panel-remove", ".watch-panel-search"]);
    await page.keyboard.press("Escape");

    await page.locator(".map-legend-fab").click();
    await expect(page.locator(".map-legend-row")).toHaveCount(4);
    await expectTargets(page, [".map-legend-row", ".map-legend-body-close"]);

    // No sideways scrolling, which a too-wide tap target would cause.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test("the resume dialog is modal: focus moves in, Escape closes, focus returns", async ({ page }) => {
    await page.setViewportSize(PHONE);
    await mockFlightApi(page);
    await freezeClock(page);
    await page.goto("/");
    await waitForMapReady(page, 60_000);

    // Something has focus when the dialog is raised, so "focus returns on
    // close" has a target to return to.
    await page.locator(".flight-search-fab").focus();
    // The dialog is raised once the fetch cycle's own stop window elapses.
    await page.clock.runFor(310_000);

    const dialog = page.locator(".resume-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute("role", "dialog");
    await expect(dialog).toHaveAttribute("aria-modal", "true");
    await expect.poll(() => page.evaluate(() => String((document.activeElement as HTMLElement | null)?.className ?? ""))).toContain("resume-dialog-button");
    for (let i = 0; i < 4; i++) await page.keyboard.press("Tab");
    expect(await page.evaluate(() => !!document.querySelector(".resume-dialog")?.contains(document.activeElement))).toBe(true);

    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => String((document.activeElement as HTMLElement | null)?.className ?? ""))).toContain("flight-search-fab");
  });
});

test.describe("prefers-reduced-motion: the preference is on", () => {
  test.use({ reducedMotion: "reduce" });

  test("the map camera jumps instead of animating, and CSS transitions are off", async ({ page }) => {
    await page.setViewportSize(PHONE);
    await mockFlightApi(page);
    await page.goto("/");
    await waitForMapReady(page, 60_000);
    await waitForChrome(page);

    // Every camera move an animation normally runs is instant: the adapter
    // reports the map as not moving straight after the call.
    const moving = await withMap(page, (map) => {
      map.setView([59.33, 18.06], 8, { animate: true });
      const afterSetView = map.isMoving();
      map.flyTo([59.33, 18.06], 9, 800);
      const afterFlyTo = map.isMoving();
      map.panTo([59.5, 18.2], 500);
      const afterPanTo = map.isMoving();
      return [afterSetView, afterFlyTo, afterPanTo];
    });
    expect(moving).toEqual([false, false, false]);
    // The camera did land where it was asked to, not nowhere.
    expect(await withMap(page, (map) => map.getZoom())).toBe(9);

    // The CSS side of the same preference: a probe element that asks for a
    // 0.45 s transition gets it squashed to (near) nothing. The !important in
    // the reduced-motion block is what lets it beat the probe's own inline
    // declaration.
    const cssDuration = await page.evaluate(() => {
      const el = document.createElement("div");
      el.style.transition = "opacity 0.45s ease";
      document.body.appendChild(el);
      const d = parseFloat(getComputedStyle(el).transitionDuration);
      el.remove();
      return d;
    });
    expect(cssDuration).toBeLessThanOrEqual(0.001);
  });

});

test.describe("prefers-reduced-motion: the preference is off", () => {
  test.use({ reducedMotion: "no-preference" });

  test("without the preference the same camera calls animate (the assertion above bites)", async ({ page }) => {
    await page.setViewportSize(PHONE);
    await mockFlightApi(page);
    await page.goto("/");
    await waitForMapReady(page, 60_000);
    await waitForChrome(page);
    const moving = await withMap(page, (map) => {
      map.flyTo([59.33, 18.06], 9, 800);
      return map.isMoving();
    });
    expect(moving).toBe(true);

    // ...and the same probe transition is left at its full length.
    const cssDuration = await page.evaluate(() => {
      const el = document.createElement("div");
      el.style.transition = "opacity 0.45s ease";
      document.body.appendChild(el);
      const d = parseFloat(getComputedStyle(el).transitionDuration);
      el.remove();
      return d;
    });
    expect(cssDuration).toBeCloseTo(0.45, 2);
  });
});
