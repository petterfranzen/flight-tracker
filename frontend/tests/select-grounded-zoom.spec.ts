import { expect, test } from "@playwright/test";
import { findMarkerNear, LIVE_FIXTURE, mockFlightApi, setMapView, waitForPlanes, withMap } from "./helpers";

// A selected aircraft that is on the ground and slow (taxiing/parked) gets
// a much closer zoom than an airborne one (see isTaxiing in map.ts).

async function selectAt(page: import("@playwright/test").Page, icao24: string, startZoom: number): Promise<number> {
  const target = LIVE_FIXTURE.find((p) => p.icao24 === icao24)!;
  await setMapView(page, target.latitude, target.longitude, startZoom);
  await waitForPlanes(page);
  await page.waitForTimeout(500);
  await (await findMarkerNear(page, target.latitude, target.longitude)).click();
  await page.getByText(`ICAO24 ${target.icao24.toUpperCase()}`).waitFor({ timeout: 2_000 });
  await page.waitForTimeout(2_500); // fresh-position wait (<=1.5s) + flyTo's 0.8s
  return withMap(page, (map) => map.getZoom());
}

test.describe("selecting a grounded aircraft", () => {
  test("zooms in far closer for a parked plane than the normal selection zoom", async ({ page }) => {
    await mockFlightApi(page);
    await page.goto("/");
    await page.waitForSelector(".map-container", { timeout: 10_000 });
    // 4aab15: onGround, 0 m/s in the live fixture.
    expect(await selectAt(page, "4aab15", 12)).toBeGreaterThanOrEqual(16);
  });

  test("an airborne aircraft keeps the normal selection zoom", async ({ page }) => {
    await mockFlightApi(page);
    await page.goto("/");
    await page.waitForSelector(".map-container", { timeout: 10_000 });
    expect(await selectAt(page, "4aad15", 11)).toBeLessThan(14);
  });
});
