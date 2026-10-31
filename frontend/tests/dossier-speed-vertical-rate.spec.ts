import { expect, test, type Page, type WebSocketRoute } from "@playwright/test";
import { findMarkerNear, LIVE_FIXTURE, mockFlightApi, setMapView, waitForMapReady, waitForPlanes } from "./helpers";

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
    await waitForMapReady(page);

    const target = LIVE_FIXTURE.find((p) => p.icao24 === "4aad15")!;
    await setMapView(page, target.latitude, target.longitude, 11);
    await waitForPlanes(page);
    await page.waitForTimeout(500);
    await (await findMarkerNear(page, target.latitude, target.longitude)).click();
    await page.getByText(`ICAO24 ${target.icao24.toUpperCase()}`).waitFor({ timeout: 2_000 });

    const speed = page.locator(".details-panel dt", { hasText: /^Speed$/ }).locator("+ dd");
    const verticalRate = page.locator(".details-panel dt", { hasText: /^Vertical rate$/ }).locator("+ dd");
    await expect(speed).toHaveText("—");
    await expect(verticalRate).toHaveText("—");

    expect(feed).not.toBeNull();
    const base = Date.now() - 60_000; // a live push is a fresh report; a stale one reads "at last report" (below)
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

// AFR88HJ at ARN: "Landed 90% (inferred)", last updated 1 h ago, yet the panel
// still read 230 km/h, -2.9 m/s and ETA 1m from its last airborne report.
test.describe("dossier values once the flight is over or the data is stale", () => {
  // The fixture's reports are months old: every one is stale.
  const target = LIVE_FIXTURE.find((p) => p.icao24 === "4d00d9")!; // airborne, 128.84 m/s, +6.5 m/s

  async function open(page: Page, state: string | null, dossier: Record<string, unknown> = {}) {
    await mockFlightApi(page);
    await page.route("**/api/aircraft/4d00d9", (route) => route.fulfill({ json: { icao24: "4d00d9", etaMinutes: 1, flightMinutes: 40, ...dossier } }));
    if (state) {
      await page.route("**/api/flights/4d00d9/status", (route) =>
        route.fulfill({
          json: { icao24: "4d00d9", state, confidence: 0.9, source: "physics", sourceKind: "inferred", lastSeenAt: target.observedAt, lastSeenLat: target.latitude, lastSeenLon: target.longitude, estimate: null, landing: null, gate: null, terminal: null, confirmedAt: null },
        }),
      );
    }
    await page.goto("/");
    await waitForMapReady(page);
    await setMapView(page, target.latitude, target.longitude, 11);
    await waitForPlanes(page);
    await (await findMarkerNear(page, target.latitude, target.longitude)).click();
    await page.getByText("ICAO24 4D00D9").waitFor({ timeout: 5_000 });
  }
  const value = (page: Page, name: string) => page.locator(".details-panel dt", { hasText: new RegExp(`^${name}$`) }).locator("+ dd");

  test("a landed flight shows no speed, climb or ETA", async ({ page }) => {
    await open(page, "LANDED_INFERRED");
    await expect(page.locator(".details-panel-status")).toHaveText(/Landed 90% \(inferred\)/);
    await expect(value(page, "Speed")).toHaveText("—");
    await expect(value(page, "Vertical rate")).toHaveText("—");
    await expect(value(page, "ETA")).toHaveText("—");
  });

  test("a stale airborne report is shown as what it was at the last report", async ({ page }) => {
    await open(page, null);
    await expect(value(page, "Speed")).toHaveText("464 km/h (at last report)");
    await expect(value(page, "Vertical rate")).toHaveText("+6.5 m/s (at last report)");
    await expect(value(page, "ETA")).toHaveText("1m (at last report)");
  });

  test("a below-zero cruising altitude is not shown", async ({ page }) => {
    // DFL5800: -23 m, a barometric reading on a high-pressure day.
    await open(page, null, { cruisingAltitudeM: -23 });
    await expect(value(page, "Cruising altitude")).toHaveText("—");
    await expect(value(page, "Altitude")).toHaveText("4755 m");
  });
});
