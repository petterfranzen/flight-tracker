import { expect, test } from "@playwright/test";
import { findMarkerNear, LIVE_FIXTURE, mockFlightApi, setMapView, waitForPlanes, withMap } from "./helpers";

// Selecting a second aircraft while one is already selected has to fly the
// map to the *new* one. Reported sequence: zoom in near ARN, select a
// plane, zoom out, pan elsewhere, zoom in, select another plane — the map
// flew back to the first plane instead. handleSelectAircraft set
// selectedId before selectedPos, so the follow logic saw "new selection"
// paired with the previous aircraft's coordinates, flew there, and then
// ignored the real position as "not a new selection" anymore.

const first = LIVE_FIXTURE.find((p) => p.icao24 === "4d00d9")!; // west of ARN
const second = LIVE_FIXTURE.find((p) => p.icao24 === "4aae47")!; // ~1.5° east

async function selectAt(page: import("@playwright/test").Page, p: typeof first): Promise<void> {
  await setMapView(page, p.latitude, p.longitude, 11);
  await waitForPlanes(page);
  await page.waitForTimeout(500);
  await (await findMarkerNear(page, p.latitude, p.longitude)).click();
  await page.getByText(`ICAO24 ${p.icao24.toUpperCase()}`).waitFor({ timeout: 5_000 });
  await page.waitForTimeout(1_200); // flyTo is 0.8s
}

const centre = (page: import("@playwright/test").Page) =>
  withMap(page, (map) => {
    const c = map.getCenter();
    return { lat: c.lat, lon: c.lon };
  });

test("selecting a second aircraft flies to it, not back to the first", async ({ page }) => {
  await mockFlightApi(page);
  await page.goto("/");
  await page.waitForSelector(".map-container", { timeout: 10_000 });

  await selectAt(page, first);
  let c = await centre(page);
  expect(Math.abs(c.lon - first.longitude)).toBeLessThan(0.05);

  // Zoom out past the cluster threshold, then go to the other aircraft.
  await setMapView(page, 59.6, 18.0, 6);
  await page.waitForTimeout(800);
  await selectAt(page, second);

  c = await centre(page);
  expect(Math.abs(c.lat - second.latitude), `centre ${JSON.stringify(c)}`).toBeLessThan(0.05);
  expect(Math.abs(c.lon - second.longitude), `centre ${JSON.stringify(c)}`).toBeLessThan(0.05);
});
