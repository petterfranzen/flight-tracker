import { expect, test } from "@playwright/test";
import { findMarkerNear, LIVE_FIXTURE, mockFlightApi, setMapView } from "./helpers";

// One basic journey, covering the aircraft-favorite path end to end
// (toggle from the details panel -> persists to localStorage -> shows up
// live in the favorites panel -> selectable from there -> removable).
// Route favoriting shares all the same underlying mechanics (favorites.ts,
// FavoritesPanel's rendering/liveness-check) but needs a real dossier
// (origin/destination) to exercise, and mockFlightApi's /api/aircraft/*
// mock is a blanket 404 — not worth widening shared test infra for a
// second journey through the same plumbing, per this repo's "basic
// journeys only" rule for UI tests.

test.describe("favorites", () => {
  test("favoriting an aircraft persists it, shows it live in the panel, and it can be selected and removed from there", async ({ page }) => {
    await mockFlightApi(page);
    await page.goto("/");
    await page.waitForSelector(".leaflet-container", { timeout: 10_000 });

    const target = LIVE_FIXTURE.find((p) => p.icao24 === "4aad15")!;
    await setMapView(page, target.latitude, target.longitude, 11);
    await page.waitForSelector(".plane-icon", { timeout: 10_000 });
    await page.waitForTimeout(500);
    await (await findMarkerNear(page, target.latitude, target.longitude)).click();
    await page.getByText(`ICAO24 ${target.icao24.toUpperCase()}`).waitFor({ timeout: 2_000 });

    const aircraftToggle = page.getByRole("button", { name: "Aircraft", exact: false });
    await expect(aircraftToggle).toHaveText("☆ Aircraft");
    await aircraftToggle.click();
    await expect(aircraftToggle).toHaveText("★ Aircraft");

    // Persisted client-side (see favorites.ts) — a reload must not lose it.
    await page.reload();
    await page.waitForSelector(".leaflet-container", { timeout: 10_000 });

    const favoritesToggle = page.locator(".favorites-panel-toggle");
    await expect(favoritesToggle).toHaveText("★ Favorites (1) ▼");
    await favoritesToggle.click();

    const favoriteItem = page.locator(".favorites-panel-item", { hasText: target.callsign! });
    await expect(favoriteItem).toBeVisible();
    // mockFlightApi's /api/flights/*/live* route serves this aircraft from
    // LIVE_FIXTURE, so the panel's liveness check should find it live.
    await expect(favoriteItem.locator(".favorites-panel-item-status")).toHaveText("live now", { timeout: 5_000 });

    await favoriteItem.locator(".favorites-panel-item-select").click();
    await page.getByText(`ICAO24 ${target.icao24.toUpperCase()}`).waitFor({ timeout: 2_000 });

    await favoriteItem.locator(".favorites-panel-item-remove").click();
    await expect(page.locator(".favorites-panel-item")).toHaveCount(0);
    await expect(favoritesToggle).toHaveText("★ Favorites ▼");
  });
});
