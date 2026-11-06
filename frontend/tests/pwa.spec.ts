import { expect, test } from "@playwright/test";
import { mockFlightApi } from "./helpers";

// #85: installability. These are the checks Chrome's install criteria and
// Lighthouse's installable audit read, kept hermetic: the dev server serves
// public/manifest.json and public/icons/ exactly as the jar serves them from
// static/ in production. The worker's own "caches nothing" rule is asserted
// too, because that is what makes a deploy's fix reach a phone.

test.describe("PWA installability", () => {
  // Booting the MapLibre app in the headless software renderer takes ~15 s,
  // and the install-control case loads it twice (goto + reload). The default
  // 30 s is not enough for two boots, not a sign of a hang.
  test.describe.configure({ timeout: 90_000 });
  test("manifest has the required fields and every icon it names resolves as a PNG", async ({ request }) => {
    const response = await request.get("/manifest.json");
    expect(response.status()).toBe(200);

    const manifest = await response.json();
    expect(manifest.name).toBe("Netwatch Skygrid");
    expect(manifest.short_name).toBe("Skygrid");
    expect(manifest.start_url).toBe("/");
    expect(manifest.scope).toBe("/");
    expect(manifest.display).toBe("standalone");
    // Both are the cyberpunk --color-bg token from FlightMap.css, not new colours.
    expect(manifest.theme_color).toBe("#050608");
    expect(manifest.background_color).toBe("#050608");

    const sizes = new Set<string>(manifest.icons.map((icon: { sizes: string }) => icon.sizes));
    expect(sizes.has("192x192")).toBe(true);
    expect(sizes.has("512x512")).toBe(true);
    expect(manifest.icons.some((icon: { purpose?: string }) => icon.purpose === "maskable")).toBe(true);

    for (const icon of manifest.icons as { src: string; sizes: string }[]) {
      const iconResponse = await request.get(icon.src);
      expect(iconResponse.status(), icon.src).toBe(200);
      expect(iconResponse.headers()["content-type"], icon.src).toContain("image/png");
      // PNG magic: 0x89 "PNG".
      expect((await iconResponse.body()).subarray(1, 4).toString(), icon.src).toBe("PNG");
    }
  });

  test("the document links the manifest and carries the iOS install meta tags", async ({ page }) => {
    await mockFlightApi(page);
    await page.goto("/");

    await expect(page.locator('link[rel="manifest"]')).toHaveAttribute("href", "/manifest.json");
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", "#050608");
    await expect(page.locator('meta[name="apple-mobile-web-app-capable"]')).toHaveAttribute("content", "yes");
    await expect(page.locator('meta[name="apple-mobile-web-app-status-bar-style"]')).toHaveAttribute("content", "black-translucent");
    await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute("href", "/icons/apple-touch-icon-180.png");

    const viewport = await page.locator('meta[name="viewport"]').getAttribute("content");
    expect(viewport).toContain("viewport-fit=cover");
    // Pinch zoom must stay enabled (the existing mobile-layout spec asserts
    // the same): viewport-fit=cover is the only change here.
    expect(viewport).not.toMatch(/maximum-scale/i);
    expect(viewport).not.toMatch(/user-scalable\s*=\s*(no|0)/i);
  });

  test("the worker registers and caches nothing", async ({ page }) => {
    await mockFlightApi(page);
    await page.goto("/");

    const state = await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.ready;
      return { scope: registration.scope, active: registration.active?.state ?? null };
    });
    expect(state.scope).toBe("http://localhost:5174/");
    expect(state.active).toBe("activated");

    // The worker's contract: no cache, so no stale shell can survive a deploy.
    expect(await page.evaluate(() => caches.keys())).toEqual([]);
  });

  test("the install control appears only when the browser offers a prompt, and a dismissal is remembered", async ({ page }) => {
    await mockFlightApi(page);
    await page.goto("/");

    const banner = page.locator(".install-banner");
    // No beforeinstallprompt yet: nothing to click.
    await expect(banner).toHaveCount(0);

    // Dispatch the event Chrome fires when the app is installable. A real
    // BeforeInstallPromptEvent cannot be constructed; the module only reads
    // preventDefault(), prompt() and userChoice, so an Event with those is
    // enough to drive the same code path.
    await page.evaluate(() => {
      const event = new Event("beforeinstallprompt") as Event & {
        prompt: () => Promise<void>;
        userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
      };
      event.prompt = async () => {};
      event.userChoice = Promise.resolve({ outcome: "dismissed", platform: "web" });
      window.dispatchEvent(event);
    });

    await expect(banner).toBeVisible();
    await expect(banner.getByRole("button", { name: "Install app" })).toBeVisible();

    await banner.getByRole("button", { name: "Not now" }).click();
    await expect(banner).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem("flighttracker:pwaInstallDismissed"))).toBe("1");

    // Remembered across a reload.
    await page.reload();
    await expect(page.locator(".install-banner")).toHaveCount(0);
  });

  test("iOS Safari gets the one-line Add to Home Screen hint, dismissable and remembered", async ({ page }) => {
    await page.addInitScript(() => {
      // iOS Safari's UA. The module offers the Share > Add to Home Screen hint
      // on iOS only because there is no beforeinstallprompt to hook there.
      Object.defineProperty(navigator, "userAgent", {
        get: () => "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
      });
      Object.defineProperty(navigator, "maxTouchPoints", { get: () => 5 });
    });
    await mockFlightApi(page);
    await page.goto("/");

    const banner = page.locator(".install-banner");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("Add to Home Screen");
    // No install button: iOS cannot be installed programmatically.
    await expect(banner.getByRole("button", { name: "Install app" })).toHaveCount(0);

    await banner.getByRole("button", { name: "Not now" }).click();
    await expect(banner).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem("flighttracker:pwaIosHintDismissed"))).toBe("1");

    await page.reload();
    await expect(page.locator(".install-banner")).toHaveCount(0);
  });

  test("the install control stays hidden when already running standalone", async ({ page }) => {
    await page.addInitScript(() => {
      const original = window.matchMedia.bind(window);
      window.matchMedia = ((query: string) => {
        if (query === "(display-mode: standalone)") {
          return {
            matches: true,
            media: query,
            onchange: null,
            addListener: () => {},
            removeListener: () => {},
            addEventListener: () => {},
            removeEventListener: () => {},
            dispatchEvent: () => false,
          } as MediaQueryList;
        }
        return original(query);
      }) as typeof window.matchMedia;
    });
    await mockFlightApi(page);
    await page.goto("/");

    await page.evaluate(() => {
      const event = new Event("beforeinstallprompt") as Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: "accepted" }> };
      event.prompt = async () => {};
      event.userChoice = Promise.resolve({ outcome: "accepted" as const });
      window.dispatchEvent(event);
    });

    await expect(page.locator(".install-banner")).toHaveCount(0);
  });
});
