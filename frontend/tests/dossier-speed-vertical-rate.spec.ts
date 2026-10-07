import { expect, test, type WebSocketRoute } from "@playwright/test";
import { findMarkerNear, LIVE_FIXTURE, mockFlightApi, setMapView } from "./helpers";

// The aircraft dossier's Speed and Vertical rate rows (dossierPanel.ts).
// Selecting from a marker only gives a LiveMarker, which carries neither,
// so both rows read "—" until a full FlightPosition arrives — here via the
// WebSocket push feed, with the priority poll held at 404 so it can't race.

test.describe("dossier speed and vertical rate", () => {
  test("show '—' until a full position arrives, then km/h and signed m/s", async ({ page }) => {
    await mockFlightApi(page);
    await page.route("**/api/flights/*/live*", (route) => route.fulfill({ status: 404, json: null }));
    let feed: WebSocketRoute | null = null;
    await page.routeWebSocket("**/ws/live", (ws) => {
      feed = ws;
    });

    await page.goto("/");
    await page.waitForSelector(".map-container", { timeout: 10_000 });

    const target = LIVE_FIXTURE.find((p) => p.icao24 === "4aad15")!;
    await setMapView(page, target.latitude, target.longitude, 11);
    await page.waitForSelector(".plane-icon", { timeout: 10_000 });
    await page.waitForTimeout(500);
    await (await findMarkerNear(page, target.latitude, target.longitude)).click();
    await page.getByText(`ICAO24 ${target.icao24.toUpperCase()}`).waitFor({ timeout: 2_000 });

    const speed = page.locator(".details-panel dt", { hasText: /^Speed$/ }).locator("+ dd");
    const verticalRate = page.locator(".details-panel dt", { hasText: /^Vertical rate$/ }).locator("+ dd");
    await expect(speed).toHaveText("—");
    await expect(verticalRate).toHaveText("—");

    expect(feed).not.toBeNull();
    const base = Date.parse(target.observedAt);
    const push = (i: number, velocityMs: number, verticalRateMs: number) =>
      feed!.send(JSON.stringify({ ...target, observedAt: new Date(base + i * 1_000).toISOString(), velocityMs, verticalRateMs }));

    push(1, 231.4, 5.2); // 833.04 km/h
    await expect(speed).toHaveText("833 km/h");
    await expect(verticalRate).toHaveText("+5.2 m/s");

    push(2, 231.4, -3);
    await expect(verticalRate).toHaveText("-3.0 m/s");

    // -0.04 rounds to -0 — must read as level flight, not "-0.0".
    push(3, 231.4, -0.04);
    await expect(verticalRate).toHaveText("+0.0 m/s");
  });
});
