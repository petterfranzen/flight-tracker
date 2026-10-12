import { expect, test } from "@playwright/test";
import { findMarkerNear, LIVE_FIXTURE, mockFlightApi, setMapView, waitForMapReady, waitForPlanes } from "./helpers";

// What "Favorite route" does must be stated on screen, including when it is
// unavailable, and the Favorites list must say what is (not) actionable.

const target = LIVE_FIXTURE.find((p) => p.icao24 === "4aad15")!;

async function selectTarget(page: import("@playwright/test").Page) {
  await page.goto("/");
  await waitForMapReady(page);
  await setMapView(page, target.latitude, target.longitude, 11);
  await waitForPlanes(page);
  await page.waitForTimeout(500);
  await (await findMarkerNear(page, target.latitude, target.longitude)).click();
  await page.getByText(`ICAO24 ${target.icao24.toUpperCase()}`).waitFor({ timeout: 5_000 });
}

test.describe("favorites clarity", () => {
  test("with no known route, the disabled Favorite route button says why", async ({ page }) => {
    await mockFlightApi(page); // /api/aircraft/* is 404: no dossier, so no route
    await selectTarget(page);
    const routeButton = page.getByRole("button", { name: "Favorite this route", exact: true });
    await expect(routeButton).toBeDisabled();
    await expect(routeButton).toHaveText("☆ Favorite route");
    await expect(page.locator(".details-panel-favorite-hint")).toHaveText("Route unknown for this flight, so it can't be favorited yet");
  });

  test("with a known route, the hint names the route and what favoriting does", async ({ page }) => {
    await mockFlightApi(page);
    await page.route("**/api/aircraft/4aad15*", (route) =>
      route.fulfill({
        json: {
          icao24: "4aad15",
          registration: null,
          model: null,
          operator: null,
          originAirport: "LEAL",
          originAirportName: "Alicante-Elche",
          originAirportIata: "ALC",
          destinationAirport: "ESSA",
          destinationAirportName: "Stockholm Arlanda",
          destinationAirportIata: "ARN",
          flightMinutes: null,
          etaMinutes: null,
          cruisingAltitudeM: null,
          flightPhase: null,
          staleExplanation: null,
          legStartAt: null,
        },
      }),
    );
    await selectTarget(page);
    const hint = page.locator(".details-panel-favorite-hint");
    await expect(hint).toHaveText("Favorite the route to see any live ALC → ARN flight in Favorites");
    await page.getByRole("button", { name: "Favorite this route", exact: true }).click();
    await expect(hint).toHaveText("Saved: ALC → ARN shows in Favorites when a flight is live");
  });

  test("Favorites list says what is actionable and labels idle rows plainly", async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem(
        "flighttracker:favoriteRoutes",
        JSON.stringify([{ origin: "ESMQ", originName: "Kalmar", originIata: "KLR", destination: "ESSA", destinationName: "Arlanda", destinationIata: "ARN" }]),
      );
    });
    await mockFlightApi(page);
    // The shared mock answers any airport query with a live flight; here the
    // route must have none. Later registrations take priority.
    await page.route("**/api/flights/search*", (route) => route.fulfill({ json: [] }));
    await page.goto("/");
    await waitForMapReady(page);
    await page.locator(".favorites-panel-toggle").click();
    const item = page.locator(".favorites-panel-item", { hasText: "KLR" });
    await expect(item.locator(".favorites-panel-item-status")).toHaveText("no live flight", { timeout: 5_000 });
    await expect(page.locator(".favorites-panel-hint")).toContainText("None live right now");
    await expect(item.locator(".favorites-panel-item-select")).toBeDisabled();
  });
});
