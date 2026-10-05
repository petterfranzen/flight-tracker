import { expect, test, type Page } from "@playwright/test";
import { mockFlightApi, setMapView } from "./helpers";

// The server keeps landed aircraft for 48 h, so the map can show a plane whose
// last report is hours old, or one that has since left a stand under whatever
// parked there next. A report older than 2 h is drawn dimmed (at any zoom); an
// older plane within 20 m of a newer one is not drawn at all (from zoom 13).
// See map/staleness.ts.

const BASE = { lat: 59.65, lon: 17.93 };
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

function marker(icao24: string, callsign: string, dLatDeg: number, minutes: number) {
  return { icao24, callsign, observedAt: minutesAgo(minutes), latitude: BASE.lat + dLatDeg, longitude: BASE.lon, headingDeg: 90 };
}

async function serve(page: Page, list: ReturnType<typeof marker>[]) {
  await mockFlightApi(page);
  // Later registration wins over the shared mock's /live.
  await page.route(/\/api\/flights\/live(\?|$)/, (route) => route.fulfill({ json: list }));
  await page.goto("/");
  await page.waitForSelector(".leaflet-container", { timeout: 10_000 });
}

/** Callsigns of every drawn plane, split into dimmed and live. */
async function drawn(page: Page, expectedCount: number) {
  await expect.poll(async () => page.locator(".plane-icon").count(), { timeout: 10_000 }).toBe(expectedCount);
  return page.evaluate(() => {
    const labels = (sel: string) =>
      Array.from(document.querySelectorAll(sel))
        .map((e) => e.querySelector(".plane-icon-label")!.textContent!)
        .sort();
    return { dimmed: labels(".plane-icon--dimmed"), live: labels(".plane-icon:not(.plane-icon--dimmed)") };
  });
}

test.describe("dimming stale aircraft", () => {
  test("an older plane parked under a newer one is not drawn; neighbours stay live", async ({ page }) => {
    await serve(page, [
      marker("aaaaaa", "FRESH1", 0, 1), // newest, on the stand
      marker("bbbbbb", "GHOST1", 0.00003, 60), // ~3 m away, 1 h old
      marker("cccccc", "GHOST2", -0.00002, 600), // ~2 m away, 10 h old: hidden, not merely dimmed
      marker("dddddd", "NEXT1", 0.0012, 5), // ~130 m away (110 px here): room for its own icon
      marker("eeeeee", "FAR1", 0.0026, 10), // ~290 m away
    ]);
    await setMapView(page, BASE.lat, BASE.lon, 16);
    const { dimmed, live } = await drawn(page, 3);
    expect(dimmed).toEqual([]);
    expect(live).toEqual(["FAR1", "FRESH1", "NEXT1"]);
  });

  test("a report older than 2 hours is dimmed even with nothing on top of it; a 90 minute one is not", async ({ page }) => {
    await serve(page, [
      marker("aaaaaa", "AGED1", 0, 180), // 3 h
      marker("bbbbbb", "RECENT1", 0.0012, 90), // 1.5 h, 130 m away
      marker("cccccc", "FRESH1", 0.0026, 1),
    ]);
    await setMapView(page, BASE.lat, BASE.lon, 16);
    const { dimmed, live } = await drawn(page, 3);
    expect(dimmed).toEqual(["AGED1"]);
    expect(live).toEqual(["FRESH1", "RECENT1"]);
  });

  test("zoomed out, age still dims", async ({ page }) => {
    await serve(page, [
      marker("aaaaaa", "FRESH1", 0, 1),
      marker("cccccc", "AGED1", 0.1, 180), // ~11 km away: its own icon at z11
    ]);
    await setMapView(page, BASE.lat, BASE.lon, 11);
    const { dimmed, live } = await drawn(page, 2);
    expect(dimmed).toEqual(["AGED1"]);
    expect(live).toEqual(["FRESH1"]);
  });

  test("the selected aircraft is never dimmed, even when its report is old", async ({ page }) => {
    await serve(page, [marker("aaaaaa", "AGED1", 0, 180), marker("bbbbbb", "FRESH1", 0.0011, 1)]);
    await setMapView(page, BASE.lat, BASE.lon, 16);
    await drawn(page, 2);
    await page.locator(".plane-icon", { hasText: "AGED1" }).click({ force: true });
    await expect(page.locator(".plane-icon--selected")).toHaveCount(1);
    await expect(page.locator(".plane-icon--selected")).not.toHaveClass(/plane-icon--dimmed/);
    await expect(page.locator(".plane-icon--selected .plane-icon-label")).toHaveText("AGED1");
  });
});
