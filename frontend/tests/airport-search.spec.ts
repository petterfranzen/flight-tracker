import { expect, test } from "@playwright/test";
import { LIVE_FIXTURE, mockFlightApi } from "./helpers";

// Covers the regression this guards against: the airport search
// used to have two inputs (origin, destination) before they were merged
// into one field matching either side of a route (see FlightController's
// searchByAirport). Kept to the two journeys that actually matter — the
// panel has one input, and searching+selecting through it works — rather
// than re-testing FlightController's own match ranking here (that's
// FlightControllerTest's job), per this repo's "basic journeys only" rule
// for UI tests.

test.describe("airport search", () => {
  test("the airport box is always there, under the flight-number box: one input, not separate origin/destination fields", async ({ page }) => {
    await mockFlightApi(page);
    await page.goto("/");
    await page.waitForSelector(".leaflet-container", { timeout: 10_000 });

    await expect(page.locator(".flight-search-airport-input")).toHaveCount(1);
    await expect(page.locator(".flight-search-airport-input")).toBeVisible();
    await expect(page.locator(".flight-search-advanced-toggle")).toHaveCount(0); // nothing to expand
    const flightBox = (await page.locator(".flight-search-input").first().boundingBox())!;
    const airportBox = (await page.locator(".flight-search-airport-input").boundingBox())!;
    expect(airportBox.y).toBeGreaterThan(flightBox.y + flightBox.height - 1);
  });

  test("searching by airport and selecting a result shows that aircraft's dossier", async ({ page }) => {
    await mockFlightApi(page);
    await page.goto("/");
    await page.waitForSelector(".leaflet-container", { timeout: 10_000 });

    const target = LIVE_FIXTURE.find((p) => p.icao24 === "4aad15")!;

    await page.locator(".flight-search-airport-input").fill("Arlanda");

    const result = page.locator(".flight-search-option", { hasText: target.callsign! });
    await result.waitFor({ timeout: 5_000 });
    await result.click();

    await expect(page.getByText(`ICAO24 ${target.icao24.toUpperCase()}`)).toBeVisible();
  });
});
