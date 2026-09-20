import { expect, test } from "@playwright/test";
import { mockFlightApi, setMapView } from "./helpers";

// Two real entries from worldMapData.ts, picked because they sit close
// together in southern Sweden but at opposite ends of Natural Earth's
// significance ranking:
//   ARN (Arlanda)    rank 2 — drawn at every zoom
//   NRK (Norrköping) rank 8 — only once you're zoomed well in
// Kept in sync by hand with MAX_RANK_BY_ZOOM in DefaultAirports.tsx,
// the same way clustering.spec.ts tracks CLUSTER_FETCH_MAX_ZOOM.
const ALWAYS_SHOWN = "ARN";
const MINOR = "NRK";

const SWEDEN = { lat: 59.0, lon: 17.0 };
const WORLD_ZOOM = 3;
const CLOSE_ZOOM = 9;

function airportLabel(page: import("@playwright/test").Page, code: string) {
  return page.locator(".default-airport-icon-label", { hasText: new RegExp(`^${code}$`) });
}

/**
 * The marker itself, not its label. The label carries `pointer-events:
 * none` (DefaultAirports.css) so it never blocks dragging the map, which
 * means clicking it lands on the map container underneath — only the dot
 * is a real click target.
 */
function airportMarker(page: import("@playwright/test").Page, code: string) {
  return page
    .locator(".default-airport-icon")
    .filter({ has: page.locator(".default-airport-icon-label", { hasText: new RegExp(`^${code}$`) }) });
}

function allAirports(page: import("@playwright/test").Page) {
  return page.locator(".default-airport-icon");
}

test.describe("airport density by zoom", () => {
  test("zoomed out, only the most significant airports are drawn", async ({ page }) => {
    await mockFlightApi(page);
    await page.goto("/");
    await page.waitForSelector(".leaflet-container", { timeout: 10_000 });

    await setMapView(page, SWEDEN.lat, SWEDEN.lon, WORLD_ZOOM);

    await expect(airportLabel(page, ALWAYS_SHOWN)).toHaveCount(1);
    // The whole point of the change: a minor regional airport is noise at
    // world scale, and 878 of them made the map unreadable.
    await expect(airportLabel(page, MINOR)).toHaveCount(0);
  });

  test("zooming in reveals the smaller ones", async ({ page }) => {
    await mockFlightApi(page);
    await page.goto("/");
    await page.waitForSelector(".leaflet-container", { timeout: 10_000 });

    await setMapView(page, SWEDEN.lat, SWEDEN.lon, WORLD_ZOOM);
    await expect(airportLabel(page, MINOR)).toHaveCount(0);

    await setMapView(page, SWEDEN.lat, SWEDEN.lon, CLOSE_ZOOM);

    await expect(airportLabel(page, MINOR)).toHaveCount(1);
    // The major one never disappears on the way in.
    await expect(airportLabel(page, ALWAYS_SHOWN)).toHaveCount(1);
  });

  test("the drawn count grows monotonically as you zoom in", async ({ page }) => {
    await mockFlightApi(page);
    await page.goto("/");
    await page.waitForSelector(".leaflet-container", { timeout: 10_000 });

    const counts: number[] = [];
    for (const zoom of [WORLD_ZOOM, 5, 7, CLOSE_ZOOM]) {
      await setMapView(page, SWEDEN.lat, SWEDEN.lon, zoom);
      // Settle: the filter runs on "zoomend", so the DOM lags setView by a
      // tick. Waiting on the count itself rather than a fixed sleep.
      await expect
        .poll(async () => allAirports(page).count(), { timeout: 10_000 })
        .toBeGreaterThan(0);
      counts.push(await allAirports(page).count());
    }

    // Deliberately not asserting exact counts (65/284/480/878 today):
    // those move whenever the Natural Earth source or the filter in
    // generate_world_map_data.py changes, and this test is about the
    // behaviour, not the dataset.
    for (let i = 1; i < counts.length; i++) {
      expect(counts[i], `zoom step ${i} should draw more than the previous`).toBeGreaterThan(
        counts[i - 1],
      );
    }
  });

  test("an airport stays clickable once it appears", async ({ page }) => {
    await mockFlightApi(page);
    await page.goto("/");
    await page.waitForSelector(".leaflet-container", { timeout: 10_000 });

    await setMapView(page, SWEDEN.lat, SWEDEN.lon, CLOSE_ZOOM);
    await expect(airportMarker(page, MINOR)).toHaveCount(1);
    await airportMarker(page, MINOR).click();

    // Filtering rebuilds the marker list on every zoom, so this guards
    // the thing most likely to break silently: a marker that renders but
    // has lost its click handler. The dossier heading is the airport's
    // name (FlightMap.tsx), falling back to its code.
    await expect(page.getByRole("heading", { name: /Norrk|NRK/ })).toBeVisible({ timeout: 10_000 });
  });
});
