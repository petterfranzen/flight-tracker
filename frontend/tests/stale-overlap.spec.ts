import { expect, test } from "@playwright/test";
import { mockFlightApi, setMapView } from "./helpers";

// The server keeps landed aircraft for 48 h, so a plane that left a stand
// without a final report stays drawn there, under whatever parked on the
// stand next. Aircraft cannot be metres apart: of any such group only the
// newest report is drawn (see map/overlap.ts).

const BASE = { lat: 59.65, lon: 17.93 };
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

function marker(icao24: string, callsign: string, dLatDeg: number, minutes: number) {
  return { icao24, callsign, observedAt: minutesAgo(minutes), latitude: BASE.lat + dLatDeg, longitude: BASE.lon, headingDeg: 90 };
}

test("a stale marker parked under a newer aircraft is not drawn; neighbours stay", async ({ page }) => {
  await mockFlightApi(page);
  // Later registration wins over the shared mock's /live.
  await page.route(/\/api\/flights\/live(\?|$)/, (route) =>
    route.fulfill({
      json: [
        marker("aaaaaa", "FRESH1", 0, 1), // newest, on the stand
        marker("bbbbbb", "GHOST1", 0.00003, 600), // ~3 m away, 10 h old
        marker("cccccc", "GHOST2", -0.00002, 300), // ~2 m away, 5 h old
        marker("dddddd", "NEXT1", 0.0005, 900), // ~55 m away: a different stand
        marker("eeeeee", "FAR1", 0.0011, 2000), // ~120 m away
      ],
    }),
  );
  await page.goto("/");
  await page.waitForSelector(".leaflet-container", { timeout: 10_000 });
  await setMapView(page, BASE.lat, BASE.lon, 16);
  await expect.poll(async () => page.locator(".plane-icon").count(), { timeout: 10_000 }).toBeGreaterThan(0);
  await page.waitForTimeout(1_000);

  const callsigns = await page.locator(".plane-icon .plane-icon-label").evaluateAll((els) => els.map((e) => e.textContent).sort());
  expect(callsigns).toEqual(["FAR1", "FRESH1", "NEXT1"]);
});

test("zoomed out, overlap hiding is not applied (nothing to see, nothing to pay)", async ({ page }) => {
  await mockFlightApi(page);
  await page.route(/\/api\/flights\/live(\?|$)/, (route) =>
    route.fulfill({ json: [marker("aaaaaa", "FRESH1", 0, 1), marker("bbbbbb", "GHOST1", 0.00003, 600)] }),
  );
  await page.goto("/");
  await page.waitForSelector(".leaflet-container", { timeout: 10_000 });
  await setMapView(page, BASE.lat, BASE.lon, 11);
  await expect.poll(async () => page.locator(".plane-icon").count(), { timeout: 10_000 }).toBe(2);
});
