import { expect, test, type Page } from "@playwright/test";
import { mockFlightApi, waitForMapReady } from "./helpers";

// section9-hq#277: an installed (Home Screen) app on iOS showed a dark dim band
// across the top of the map, from the screen edge down to the first control
// button (~65 pt). The cause was the deprecated
// `apple-mobile-web-app-status-bar-style: black-translucent` meta: iOS 26.1+
// no longer draws the page under the status bar and instead paints a dark scrim
// over that strip. The fix removes the meta so the bar takes the theme colour
// and the page starts below it.
//
// Playwright cannot emulate the iOS status bar itself, but it can emulate the
// safe-area insets the app lays out against (CDP
// Emulation.setSafeAreaInsetsOverride) and the installed-app class the app sets
// from navigator.standalone. This guards the DOM half of the fix: the map
// canvas must start at y=0 and nothing opaque may cover the top strip, with no
// band at the bottom either (#201).

const IPHONE = { width: 390, height: 844 };
const TOP_INSET = 62;
const BOTTOM_INSET = 34;

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

test.describe("installed app: no band across the top", () => {
  test.describe.configure({ timeout: 120_000 });

  test("the status-bar-style meta is gone, so iOS cannot draw its scrim", async ({ page }) => {
    await installedApp(page);
    await expect(page.locator('meta[name="apple-mobile-web-app-status-bar-style"]')).toHaveCount(0);
    // The bar still needs a colour to take: the cyberpunk --color-bg token.
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", "#050608");
  });

  test("the map canvas starts at y=0 and nothing opaque covers the top strip", async ({ page }) => {
    await installedApp(page);

    const geometry = await page.evaluate(() => {
      const canvas = document.querySelector(".map-container canvas") as HTMLElement | null;
      const shell = document.querySelector(".app-shell") as HTMLElement | null;
      const box = (el: Element | null) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { top: r.top, left: r.left, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
      };
      // Walk the top strip at three columns: the map must be the topmost thing
      // there, or whatever is on top must be fully transparent.
      const probes: { x: number; y: number; tag: string; cls: string; opaque: boolean }[] = [];
      for (const x of [20, 195, 370]) {
        for (const y of [0, 8, 16, 32, 48, 60]) {
          const el = document.elementFromPoint(x, y) as HTMLElement | null;
          const cs = el ? getComputedStyle(el) : null;
          const bg = cs?.backgroundColor ?? "rgba(0, 0, 0, 0)";
          const alpha = bg.startsWith("rgba(") ? Number(bg.slice(5, -1).split(",")[3]) : 1;
          const hasImage = !!cs && cs.backgroundImage !== "none";
          probes.push({
            x,
            y,
            tag: el?.tagName ?? "none",
            cls: el && typeof el.className === "string" ? el.className : "",
            opaque: alpha > 0 || hasImage,
          });
        }
      }
      return {
        innerHeight: window.innerHeight,
        innerWidth: window.innerWidth,
        canvas: box(canvas),
        shell: box(shell),
        probes,
      };
    });

    // The map runs to the very top and the very bottom of the viewport.
    expect(geometry.canvas).not.toBeNull();
    expect(geometry.canvas!.top).toBe(0);
    expect(geometry.canvas!.left).toBe(0);
    expect(geometry.canvas!.width).toBe(geometry.innerWidth);
    expect(geometry.canvas!.bottom).toBe(geometry.innerHeight);

    // No band at the bottom either (#201): the shell fills the viewport.
    expect(geometry.shell).not.toBeNull();
    expect(geometry.shell!.top).toBe(0);
    expect(geometry.shell!.bottom).toBe(geometry.innerHeight);

    // Nothing opaque sits over the top strip.
    const covering = geometry.probes.filter((p) => p.opaque);
    expect(covering, `opaque elements over the top strip: ${JSON.stringify(covering)}`).toEqual([]);
  });
});
