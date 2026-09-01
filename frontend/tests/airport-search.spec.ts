import { expect, test } from "@playwright/test";
import { LIVE_FIXTURE, mockFlightApi } from "./helpers";

// Covers the regression this guards against: the advanced search panel
// used to have two inputs (origin, destination) before they were merged
// into one field matching either side of a route (see FlightController's
// searchByAirport). Kept to the two journeys that actually matter — the
// panel has one input, and searching+selecting through it works — rather
// than re-testing FlightController's own match ranking here (that's
// FlightControllerTest's job), per this repo's "basic journeys only" rule
// for UI tests.

test.describe("advanced (airport) search", () => {
  test("advanced search panel has exactly one input, not separate origin/destination fields", async ({ page }) => {
    await mockFlightApi(page);
    await page.goto("/");
    await page.waitForSelector(".leaflet-container", { timeout: 10_000 });

    await page.locator(".flight-search-advanced-toggle").click();
    await expect(page.locator(".flight-search-advanced-input")).toHaveCount(1);
  });

  test("searching by airport and selecting a result shows that aircraft's dossier", async ({ page }) => {
    await mockFlightApi(page);
    await page.goto("/");
    await page.waitForSelector(".leaflet-container", { timeout: 10_000 });

    const target = LIVE_FIXTURE.find((p) => p.icao24 === "4aad15")!;

    await page.locator(".flight-search-advanced-toggle").click();
    await page.locator(".flight-search-advanced-input").fill("Arlanda");

    const result = page.locator(".flight-search-option", { hasText: target.callsign! });
    await result.waitFor({ timeout: 5_000 });
    await result.click();

    await expect(page.getByText(`ICAO24 ${target.icao24.toUpperCase()}`)).toBeVisible();
  });
});
