import { expect, test, type Page } from "@playwright/test";
import { mockFlightApi, setMapView } from "./helpers";

// Clusters (and, in a busy view, the markers) show active traffic: in the
// air, reported within 2 h. Parked or silent aircraft wait until the view is
// sparse enough to draw everything (zoom in). See map/staleness.ts and
// LiveVisibilityWindows.ACTIVE_TRAFFIC_WINDOW on the server.

const BASE = { lat: 59.65, lon: 17.93 };
const CAP = 800; // MAX_INDIVIDUAL_MARKERS in main.ts
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

/** `n` aircraft spread over a ~2 x 1 degree patch, so they all sit in a zoom-9 viewport. */
function patch(prefix: string, n: number, opts: { onGround: boolean; ageMinutes: number }) {
  return Array.from({ length: n }, (_, i) => ({
    icao24: `${prefix}${i.toString(16).padStart(5, "0")}`,
    callsign: `${prefix.toUpperCase()}${i}`,
    observedAt: minutesAgo(opts.ageMinutes),
    latitude: BASE.lat - 0.5 + (Math.floor(i / 40) % 25) * 0.04,
    longitude: BASE.lon - 1 + (i % 40) * 0.05,
    headingDeg: 90,
    onGround: opts.onGround,
  }));
}

async function serve(page: Page, list: ReturnType<typeof patch>) {
  await mockFlightApi(page);
  await page.route(/\/api\/flights\/live(\?|$)/, (route) => route.fulfill({ json: list }));
  await page.goto("/");
  await page.waitForSelector(".leaflet-container", { timeout: 10_000 });
  await setMapView(page, BASE.lat, BASE.lon, 9);
}

test.describe("active traffic vs parked aircraft", () => {
  test("a sparse view draws everything, parked planes included", async ({ page }) => {
    await serve(page, [...patch("a", 20, { onGround: false, ageMinutes: 1 }), ...patch("g", 30, { onGround: true, ageMinutes: 1 })]);
    await expect.poll(async () => page.locator(".plane-icon").count(), { timeout: 10_000 }).toBe(50);
    await expect(page.locator(".cluster-icon")).toHaveCount(0);
  });

  test("a busy view holds parked and silent aircraft back and draws the active ones individually", async ({ page }) => {
    await serve(page, [
      ...patch("a", 60, { onGround: false, ageMinutes: 1 }), // active
      ...patch("g", CAP, { onGround: true, ageMinutes: 1 }), // parked: > cap in total
      ...patch("s", 30, { onGround: false, ageMinutes: 300 }), // airborne but silent for 5 h
    ]);
    await expect.poll(async () => page.locator(".plane-icon").count(), { timeout: 10_000 }).toBe(60);
    await expect(page.locator(".cluster-icon")).toHaveCount(0);
    const callsigns = await page.locator(".plane-icon .plane-icon-label").evaluateAll((els) => els.map((e) => e.textContent!));
    expect(callsigns.every((c) => c.startsWith("A"))).toBe(true);
  });

  test("a busy view with more active flights than the cap is clustered, and parked ones don't count", async ({ page }) => {
    await serve(page, [...patch("a", CAP + 100, { onGround: false, ageMinutes: 1 }), ...patch("g", 300, { onGround: true, ageMinutes: 1 })]);
    await expect.poll(async () => page.locator(".cluster-icon").count(), { timeout: 10_000 }).toBeGreaterThan(0);
    await expect(page.locator(".plane-icon")).toHaveCount(0);
  });
});
