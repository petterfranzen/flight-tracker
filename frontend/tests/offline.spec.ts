import { expect, test, type Page } from "@playwright/test";
import { mockFlightApi, renderedPlanes, setMapView, trackRequests, waitForMapReady, waitForPlanes } from "./helpers";

// #181: the app on a slow or absent network. Two halves:
//
//  - the app's own offline state: going offline dims every drawn plane (so
//    nothing reads as live traffic) and raises the themed banner; coming back
//    clears it and the live feed resumes with no reload (tests here).
//  - the service worker's shell cache: a navigation with no network is served
//    from the cache instead of the browser's error page. That half needs the
//    *built* bundle (only its content-hashed /assets/* graph is cached), so it
//    runs against the production preview on 4173, the same second server the
//    repo's production-build.spec.ts uses.

const PREVIEW = "http://localhost:4173/";
const BASE = { lat: 59.65, lon: 17.93 };
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

function marker(icao24: string, callsign: string, dLatDeg: number, minutes: number) {
  return { icao24, callsign, observedAt: minutesAgo(minutes), latitude: BASE.lat + dLatDeg, longitude: BASE.lon, headingDeg: 90 };
}

/** Two aircraft whose reports are minutes old, so age alone never dims them. */
async function serveFreshLive(page: Page, list: ReturnType<typeof marker>[]): Promise<void> {
  await mockFlightApi(page);
  // Later registration wins over the shared mock's /live.
  await page.route(/\/api\/flights\/live(\?|$)/, (route) => route.fulfill({ json: list }));
}

test.describe("offline behaviour", () => {
  test.describe.configure({ timeout: 120_000 });

  test("going offline dims every plane and raises the offline state; coming back clears it and refetches live data", async ({ page, context }) => {
    await serveFreshLive(page, [marker("aaaaaa", "LIVE1", 0, 1), marker("bbbbbb", "LIVE2", 0.0012, 5)]);
    const live = trackRequests(page, /\/api\/flights\/live(\?|$)/);
    await page.goto("/");
    await waitForMapReady(page, 60_000);
    await setMapView(page, BASE.lat, BASE.lon, 16);
    await waitForPlanes(page, 2, 30_000);

    // Online: both planes are drawn live (fresh reports), no banner.
    await expect
      .poll(async () => (await renderedPlanes(page)).filter((p) => !p.dimmed).length, { timeout: 30_000 })
      .toBe(2);
    await expect(page.locator(".offline-notice")).toBeHidden();

    // Offline: every plane is dimmed — a frozen plane must never read as live —
    // and the banner says why.
    await context.setOffline(true);
    await expect(page.locator(".offline-notice")).toBeVisible();
    await expect(page.locator(".offline-notice")).toContainText("live data unavailable");
    await expect.poll(async () => (await renderedPlanes(page)).filter((p) => p.dimmed).length, { timeout: 30_000 }).toBe(2);
    // The dimmed set is exactly the drawn set: no plane is left looking live.
    expect((await renderedPlanes(page)).length).toBe(2);

    // Back online: the banner clears and the live feed answers again without a
    // reload — a new viewport fetch lands.
    await context.setOffline(false);
    await expect(page.locator(".offline-notice")).toBeHidden();
    const before = live.sent.length;
    await setMapView(page, BASE.lat, BASE.lon + 3, 16);
    await expect.poll(() => live.landed.length - before, { timeout: 30_000 }).toBeGreaterThan(0);
  });

  test("the cached shell is answered by the worker, not the network, and does not wait on a slow API", async ({ page }) => {
    await mockFlightApi(page);
    await page.goto(PREVIEW);
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });

    // Every live-data call takes 3 s; the shell must not need any of them.
    await page.route("**/api/**", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      await route.continue().catch(() => {});
    });
    // A handler on the document URL itself. The worker answers the navigation
    // from its cache, so this never fires — which is what "loads from cache
    // first, does not block on the network" means.
    let documentRequests = 0;
    await page.route(PREVIEW, (route) => {
      documentRequests += 1;
      return route.continue();
    });

    const response = await page.goto(PREVIEW);
    expect(response?.status()).toBe(200);
    await expect(page.locator(".app-shell")).toHaveCount(1);
    expect(documentRequests, "the shell navigation was answered from the worker's cache, not the network").toBe(0);
  });

  test("a navigation with no network is served from the cached shell, not the browser's error page", async ({ page, context }) => {
    await mockFlightApi(page);
    await page.goto(PREVIEW);
    // `ready` resolves once the worker is active, and the worker precaches the
    // shell before it activates (install builds the cache, then skipWaiting).
    const active = await page.evaluate(async () => (await navigator.serviceWorker.ready).active?.state ?? null);
    expect(active).toBe("activated");

    await context.setOffline(true);
    const response = await page.goto(PREVIEW, { waitUntil: "domcontentloaded" });
    expect(response?.status()).toBe(200);

    // The real shell, from the cache: the SPA mount point and the offline state.
    expect(await page.locator("#root").count()).toBe(1);
    await expect(page.locator(".app-shell")).toHaveCount(1);
    await expect(page.locator(".offline-notice")).toBeVisible();
    await expect(page.locator(".offline-notice")).toContainText("Offline");

    // Live data is never served from the cache: those requests failed outright.
    const cached = await page.evaluate(async () => {
      const paths: string[] = [];
      for (const name of await caches.keys()) {
        const cache = await caches.open(name);
        for (const req of await cache.keys()) paths.push(new URL(req.url).pathname);
      }
      return paths;
    });
    expect(cached.some((path) => path.startsWith("/api") || path.startsWith("/ws"))).toBe(false);
  });
});
