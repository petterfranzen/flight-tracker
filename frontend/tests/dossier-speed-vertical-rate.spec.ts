import { expect, test, type Page, type WebSocketRoute } from "@playwright/test";
import type { AircraftDossier, TrackStatus } from "../src/types/flight";
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
    const base = Date.now(); // a current report: the fixture's own time is long stale, which marks these rows
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

// After a landing, or once the data is stale, the last report's speed, climb
// and ETA are not readings any more (AFR88HJ at ARN: "Landed 90% (inferred)",
// updated 1 h ago, still showing 230 km/h, -2.9 m/s and ETA 1m).
test.describe("dossier rows after a landing or when stale", () => {
  const target = LIVE_FIXTURE.find((p) => p.icao24 === "4d00d9")!;
  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

  async function open(page: Page, o: { ageMinutes: number; onGround?: boolean; state?: TrackStatus["state"]; cruisingAltitudeM?: number }) {
    await mockFlightApi(page);
    const observedAt = minutesAgo(o.ageMinutes);
    await page.route("**/api/flights/4d00d9/live*", (route) =>
      route.fulfill({ json: { ...target, observedAt, onGround: o.onGround ?? false, altitudeM: 400, velocityMs: 63.9, verticalRateMs: -2.9 } }),
    );
    await page.route("**/api/flights/4d00d9/status", (route) =>
      o.state
        ? route.fulfill({
            json: {
              icao24: target.icao24, state: o.state, confidence: 0.9, source: "physics", sourceKind: "inferred",
              lastSeenAt: observedAt, lastSeenLat: target.latitude, lastSeenLon: target.longitude,
              estimate: null, landing: null, gate: null, terminal: null, confirmedAt: null,
            } satisfies TrackStatus,
          })
        : route.fulfill({ status: 404, json: null }),
    );
    const dossier: AircraftDossier = {
      icao24: target.icao24, registration: "F-HPJA", model: "A320", operator: "Air France",
      originAirport: "LFPG", originAirportName: "Paris CDG", originAirportIata: "CDG",
      destinationAirport: "ESSA", destinationAirportName: "Stockholm Arlanda", destinationAirportIata: "ARN",
      flightMinutes: 150, etaMinutes: 1, cruisingAltitudeM: o.cruisingAltitudeM ?? 11_000, flightPhase: "LANDING", staleExplanation: null, legStartAt: null,
    };
    await page.route("**/api/aircraft/4d00d9", (route) => route.fulfill({ json: dossier }));
    await page.goto("/");
    await waitForMapReady(page);
    await setMapView(page, target.latitude, target.longitude, 11);
    await waitForPlanes(page);
    await (await findMarkerNear(page, target.latitude, target.longitude)).click();
    await page.getByText("ICAO24 4D00D9").waitFor({ timeout: 5_000 });
    // The dossier has landed once the operator shows.
    await expect(row(page, "Operator")).toHaveText("Air France");
  }
  const row = (page: Page, name: string) => page.locator(".details-panel dt", { hasText: new RegExp(`^${name}$`) }).locator("+ dd");

  test("a current report shows speed, vertical rate and ETA as they are", async ({ page }) => {
    await open(page, { ageMinutes: 0 });
    await expect(row(page, "Speed")).toHaveText("230 km/h");
    await expect(row(page, "Vertical rate")).toHaveText("-2.9 m/s");
    await expect(row(page, "ETA")).toHaveText("1m");
  });

  test("once a landing is inferred they read '—'", async ({ page }) => {
    await open(page, { ageMinutes: 0, state: "LANDED_INFERRED" });
    await expect(page.locator(".details-panel-status")).toHaveAttribute("data-track-state", "LANDED_INFERRED");
    await expect(row(page, "Speed")).toHaveText("—");
    await expect(row(page, "Vertical rate")).toHaveText("—");
    await expect(row(page, "ETA")).toHaveText("—");
  });

  test("stale, speed and vertical rate are marked as the last report's, and there is no ETA", async ({ page }) => {
    await open(page, { ageMinutes: 60 });
    await expect(row(page, "Speed")).toHaveText("230 km/h (last report)");
    await expect(row(page, "Vertical rate")).toHaveText("-2.9 m/s (last report)");
    await expect(row(page, "ETA")).toHaveText("—");
  });

  test("on the ground there is no ETA", async ({ page }) => {
    await open(page, { ageMinutes: 0, onGround: true });
    await expect(row(page, "ETA")).toHaveText("—");
  });

  test("a cruising altitude below sea level reads '—'", async ({ page }) => {
    // DFL5800: barometric altitude on a high-pressure day, a low flight near the coast.
    await open(page, { ageMinutes: 0, cruisingAltitudeM: -23 });
    await expect(row(page, "Cruising altitude")).toHaveText("—");
  });
});
