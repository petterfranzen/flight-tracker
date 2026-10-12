import { expect, test, type Page } from "@playwright/test";
import { findMarkerNear, getMapLatLngToContainerPoint, getUncertaintyRings, renderedPlanes, LIVE_FIXTURE, mockFlightApi, setMapView, waitForPlanes } from "./helpers";
import type { TrackStatus } from "../src/types/flight";

// The coverage-gap status: the dossier's status line and the uncertainty cone
// (ui/dossierPanel.ts, map/uncertainty.ts), fed by GET /api/flights/{icao24}/status.

test.use({ timezoneId: "UTC" }); // the landing time is shown in local time

const plane = LIVE_FIXTURE.find((p) => p.icao24 === "4d00d9")!;

function status(overrides: Partial<TrackStatus>): TrackStatus {
  return {
    icao24: plane.icao24,
    state: "COVERAGE_LOST",
    confidence: 0.85,
    source: "physics",
    sourceKind: "inferred",
    lastSeenAt: plane.observedAt,
    lastSeenLat: plane.latitude,
    lastSeenLon: plane.longitude,
    estimate: { lat: plane.latitude + 0.05, lon: plane.longitude + 0.03, radiusM: 1800, at: "2026-10-12T11:02:00Z", landingProbability: 0.4 },
    landing: null,
    gate: null,
    terminal: null,
    confirmedAt: null,
    ...overrides,
  };
}

const LANDING = { airportIcao: "ESSA", runway: "19R", touchdownAt: "2026-10-12T11:03:10Z" };

async function open(page: Page, served: () => TrackStatus | null, requests?: { count: number }, opts?: { noLivePoll?: boolean }) {
  await mockFlightApi(page);
  // The /live poll would put the plane back at the fixture position; with it off, only the status moves it.
  if (opts?.noLivePoll) await page.route("**/api/flights/4d00d9/live*", (route) => route.fulfill({ status: 404, json: null }));
  await page.route("**/api/flights/4d00d9/status", (route) => {
    if (requests) requests.count++;
    const s = served();
    return s ? route.fulfill({ json: s }) : route.fulfill({ status: 404, json: null });
  });
  await page.goto("/");
  await page.waitForSelector(".map-container", { timeout: 10_000 });
  await setMapView(page, plane.latitude, plane.longitude, 11);
  await waitForPlanes(page);
  await page.waitForTimeout(500);
  await (await findMarkerNear(page, plane.latitude, plane.longitude)).click();
  await page.getByText("ICAO24 4D00D9").waitFor({ timeout: 5_000 });
}

const statusLine = (page: Page) => page.locator(".details-panel-status");

test.describe("coverage-gap status line", () => {
  test("COVERAGE_LOST shows the estimate radius, and the landing when there is one", async ({ page }) => {
    await open(page, () => status({ landing: null }));
    await expect(statusLine(page)).toHaveText("Coverage lost · est. ±1.8 km");
    await expect(statusLine(page)).toHaveAttribute("data-track-state", "COVERAGE_LOST");
    await expect(statusLine(page)).toHaveAttribute("data-source-kind", "inferred");
    await expect(statusLine(page)).toHaveClass(/details-panel-status--inferred/);
  });

  test("COVERAGE_LOST with a landing prediction adds the time and runway; under 1 km reads in metres", async ({ page }) => {
    await open(page, () => status({ landing: LANDING, estimate: { ...status({}).estimate!, radiusM: 643 } }));
    await expect(statusLine(page)).toHaveText("Coverage lost · est. ±640 m · landing ~11:03 ESSA 19R");
  });

  test("from 10 km the radius is whole kilometres, as in the backend's label", async ({ page }) => {
    await open(page, () => status({ estimate: { ...status({}).estimate!, radiusM: 43_400 } }));
    await expect(statusLine(page)).toHaveText("Coverage lost · est. ±43 km");
  });

  test("LANDED_INFERRED shows the probability and runway", async ({ page }) => {
    await open(page, () => status({ state: "LANDED_INFERRED", confidence: 0.92, landing: LANDING }));
    await expect(statusLine(page)).toHaveText("Landed 92% (inferred) · ESSA 19R");
    await expect(statusLine(page)).toHaveAttribute("data-track-state", "LANDED_INFERRED");
  });

  test("ON_GROUND is observed", async ({ page }) => {
    await open(page, () => status({ state: "ON_GROUND", source: "adsb", sourceKind: "observed", estimate: null }));
    await expect(statusLine(page)).toHaveText("On ground (ADS-B)");
    await expect(statusLine(page)).toHaveAttribute("data-track-state", "ON_GROUND");
    await expect(statusLine(page)).toHaveAttribute("data-source-kind", "observed");
    await expect(statusLine(page)).toHaveClass(/details-panel-status--observed/);
  });

  test("LANDED_CONFIRMED names its source", async ({ page }) => {
    await open(page, () => status({ state: "LANDED_CONFIRMED", source: "flightaware", sourceKind: "confirmed", estimate: null }));
    await expect(statusLine(page)).toHaveText("Landed (confirmed · flightaware)");
    await expect(statusLine(page)).toHaveClass(/details-panel-status--confirmed/);
  });

  test("AT_GATE shows the gate", async ({ page }) => {
    await open(page, () => status({ state: "AT_GATE", source: "flightaware", sourceKind: "confirmed", estimate: null, gate: "B14" }));
    await expect(statusLine(page)).toHaveText("At gate B14 (confirmed)");
    await expect(statusLine(page)).toHaveAttribute("data-track-state", "AT_GATE");
  });

  test("AT_GATE without a gate reads 'At gate (confirmed)', never 'null'", async ({ page }) => {
    await open(page, () => status({ state: "AT_GATE", source: "mock", sourceKind: "confirmed", estimate: null, gate: null, terminal: null }));
    await expect(statusLine(page)).toHaveText("At gate (confirmed)");
  });

  test.describe("provider credit", () => {
    const credit = (page: Page) => statusLine(page).locator("a");

    test("LANDED_CONFIRMED from AeroDataBox credits it with a link to its site", async ({ page }) => {
      await open(page, () => status({ state: "LANDED_CONFIRMED", source: "aerodatabox", sourceKind: "confirmed", estimate: null }));
      await expect(statusLine(page)).toHaveText("Landed (confirmed · AeroDataBox)");
      await expect(credit(page)).toHaveCount(1);
      await expect(credit(page)).toHaveText("AeroDataBox");
      await expect(credit(page)).toHaveAttribute("href", "https://aerodatabox.com");
      await expect(credit(page)).toHaveAttribute("target", "_blank");
      await expect(credit(page)).toHaveAttribute("rel", "noopener noreferrer");
    });

    test("AT_GATE from AeroDataBox shows the gate and the credit", async ({ page }) => {
      await open(page, () => status({ state: "AT_GATE", source: "aerodatabox", sourceKind: "confirmed", estimate: null, gate: "B14" }));
      await expect(statusLine(page)).toHaveText("At gate B14 (confirmed · AeroDataBox)");
      await expect(credit(page)).toHaveText("AeroDataBox");
      await expect(credit(page)).toHaveAttribute("href", "https://aerodatabox.com");
      await expect(credit(page)).toHaveAttribute("target", "_blank");
      await expect(credit(page)).toHaveAttribute("rel", "noopener noreferrer");
    });

    test("AT_GATE from AeroDataBox without a gate still carries the credit", async ({ page }) => {
      await open(page, () => status({ state: "AT_GATE", source: "aerodatabox", sourceKind: "confirmed", estimate: null, gate: null }));
      await expect(statusLine(page)).toHaveText("At gate (confirmed · AeroDataBox)");
      await expect(credit(page)).toHaveCount(1);
    });

    test("clicking the credit leaves the panel open", async ({ page }) => {
      // The link opens a new tab; keep the test offline.
      await page.context().route("https://aerodatabox.com/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<title>x</title>" }));
      await open(page, () => status({ state: "LANDED_CONFIRMED", source: "aerodatabox", sourceKind: "confirmed", estimate: null }));
      const popup = page.waitForEvent("popup");
      await credit(page).click();
      await (await popup).close();
      await expect(page.getByText("ICAO24 4D00D9")).toBeVisible();
      await expect(statusLine(page)).toHaveText("Landed (confirmed · AeroDataBox)");
    });

    test("Swedavia reads as its name, with no link", async ({ page }) => {
      await open(page, () => status({ state: "LANDED_CONFIRMED", source: "swedavia", sourceKind: "confirmed", estimate: null }));
      await expect(statusLine(page)).toHaveText("Landed (confirmed · Swedavia)");
      await expect(credit(page)).toHaveCount(0);
    });

    test("Swedavia at the gate keeps the plain label, with no link", async ({ page }) => {
      await open(page, () => status({ state: "AT_GATE", source: "swedavia", sourceKind: "confirmed", estimate: null, gate: "B14" }));
      await expect(statusLine(page)).toHaveText("At gate B14 (confirmed)");
      await expect(credit(page)).toHaveCount(0);
    });

    test("an unknown provider is shown as its id, with no link", async ({ page }) => {
      await open(page, () => status({ state: "LANDED_CONFIRMED", source: "mock", sourceKind: "confirmed", estimate: null }));
      await expect(statusLine(page)).toHaveText("Landed (confirmed · mock)");
      await expect(credit(page)).toHaveCount(0);
    });
  });

  test("LIVE, and an unknown status (404), show no status line and keep the stale explanation", async ({ page }) => {
    await open(page, () => status({ state: "LIVE", confidence: null, source: "adsb", sourceKind: "observed", estimate: null }));
    await page.waitForTimeout(500);
    await expect(statusLine(page)).toHaveCount(0);
    // The fixture position is long past the stale threshold: the usual explanation stays.
    await expect(page.locator(".details-panel-updated")).toContainText("no recent updates");
  });

  test("with a status line, the stale line keeps 'Last updated' but drops the explanation", async ({ page }) => {
    await open(page, () => status({}));
    await expect(statusLine(page)).toBeVisible();
    const updated = page.locator(".details-panel-updated");
    await expect(updated).toHaveText(/^⚠ Last updated .* ago$/);
  });
});

test.describe("uncertainty cone", () => {
  test("is the convex hull of the last seen point and the estimate circle, and goes away on deselect", async ({ page }) => {
    const s = status({});
    await open(page, () => s);
    await expect.poll(() => getUncertaintyRings(page).then((r) => r.length), { timeout: 5_000 }).toBe(1);
    const [ring] = await getUncertaintyRings(page);
    expect(ring.length).toBeGreaterThan(20); // the circle's vertices on the far side, plus the last seen point
    expect(ring[0]).toEqual(ring[ring.length - 1]);
    // The last seen point is outside the circle, so it is a vertex of the hull.
    expect(ring.some((v) => Math.abs(v.lat - s.lastSeenLat) < 1e-9 && Math.abs(v.lon - s.lastSeenLon) < 1e-9)).toBe(true);

    await page.locator(".details-panel-close").click();
    await expect.poll(() => getUncertaintyRings(page).then((r) => r.length), { timeout: 5_000 }).toBe(0);
  });

  test("is just the circle, round at this latitude, when the last seen point is inside it", async ({ page }) => {
    const estimate = { lat: plane.latitude, lon: plane.longitude, radiusM: 3000, at: "2026-10-12T11:02:00Z", landingProbability: 0.4 };
    await open(page, () => status({ estimate }));
    await expect.poll(() => getUncertaintyRings(page).then((r) => r.length), { timeout: 5_000 }).toBe(1);
    const [ring] = await getUncertaintyRings(page);
    expect(ring).toHaveLength(49); // 48 vertices, closed
    const lats = ring.map((v) => v.lat);
    const lons = ring.map((v) => v.lon);
    const heightM = (Math.max(...lats) - Math.min(...lats)) * 111_195;
    const widthM = (Math.max(...lons) - Math.min(...lons)) * 111_195 * Math.cos((plane.latitude * Math.PI) / 180);
    expect(heightM).toBeCloseTo(6000, -2);
    expect(widthM / heightM).toBeGreaterThan(0.98);
    expect(widthM / heightM).toBeLessThan(1.02);
  });

  test("near the antimeridian it wraps the longitudes instead of spanning the globe", async ({ page }) => {
    // lastSeenAt is old, so the selected marker stays where it is (see the marker tests below).
    const near180 = status({
      lastSeenAt: "2000-01-01T00:00:00Z",
      lastSeenLat: 60,
      lastSeenLon: 179.97,
      estimate: { lat: 60, lon: -179.98, radiusM: 2000, at: "2026-10-12T11:02:00Z", landingProbability: 0.4 },
    });
    await open(page, () => near180);
    await expect.poll(() => getUncertaintyRings(page).then((r) => r.length), { timeout: 5_000 }).toBe(1);
    const [ring] = await getUncertaintyRings(page);
    for (const v of ring) {
      expect(v.lon).toBeGreaterThanOrEqual(-180);
      expect(v.lon).toBeLessThanOrEqual(180);
      const wrapped = ((((v.lon - near180.estimate!.lon + 180) % 360) + 360) % 360) - 180;
      expect(Math.abs(wrapped)).toBeLessThan(0.1); // a few km, not ~360 degrees away
    }
    // the last seen point is a vertex, at its own longitude
    expect(ring.some((v) => Math.abs(v.lat - 60) < 1e-9 && Math.abs(v.lon - 179.97) < 1e-9)).toBe(true);
  });

  test("is empty without an estimate", async ({ page }) => {
    await open(page, () => status({ state: "ON_GROUND", source: "adsb", sourceKind: "observed", estimate: null }));
    await expect(statusLine(page)).toBeVisible();
    expect(await getUncertaintyRings(page)).toHaveLength(0);
  });
});

test.describe("status polling", () => {
  test("refetches every 15 s while coverage is lost, and stops once it is not", async ({ page }) => {
    await page.clock.install(); // before the page starts its timers; time still flows until we jump it
    const requests = { count: 0 };
    let served = status({});
    await open(page, () => served, requests);
    await expect(statusLine(page)).toHaveText("Coverage lost · est. ±1.8 km");
    const afterSelect = requests.count;
    expect(afterSelect).toBeGreaterThanOrEqual(1);

    // The cone grows between refetches.
    served = status({ estimate: { ...status({}).estimate!, radiusM: 2400 } });
    await page.clock.runFor(15_000);
    await expect.poll(() => requests.count, { timeout: 5_000 }).toBeGreaterThan(afterSelect);
    await expect(statusLine(page)).toHaveText("Coverage lost · est. ±2.4 km");

    // Landed: no more refetches on the 15 s timer (the 72 s poll is a long way off, and LANDED_INFERRED refetches only every 60 s).
    served = status({ state: "LANDED_INFERRED", confidence: 0.92, landing: LANDING });
    await page.clock.runFor(15_000);
    await expect(statusLine(page)).toHaveText("Landed 92% (inferred) · ESSA 19R");
    const afterLanded = requests.count;
    await page.clock.runFor(20_000);
    expect(requests.count).toBe(afterLanded);
  });

  test("refetches every 60 s while the landing is inferred, so a confirmation appears without reselecting", async ({ page }) => {
    await page.clock.install();
    const requests = { count: 0 };
    let served = status({ state: "LANDED_INFERRED", confidence: 0.92, landing: LANDING });
    await open(page, () => served, requests);
    await expect(statusLine(page)).toHaveText("Landed 92% (inferred) · ESSA 19R");
    const afterSelect = requests.count;

    // Not on the 15 s coverage timer.
    await page.clock.runFor(20_000);
    expect(requests.count).toBe(afterSelect);

    served = status({ state: "AT_GATE", source: "mock", sourceKind: "confirmed", estimate: null, landing: LANDING, gate: "B14", terminal: "2" });
    await page.clock.runFor(41_000);
    await expect.poll(() => requests.count, { timeout: 5_000 }).toBeGreaterThan(afterSelect);
    await expect(statusLine(page)).toHaveText("At gate B14 (confirmed)");
    await expect(statusLine(page)).toHaveAttribute("data-source-kind", "confirmed");
  });

  test("refetches every 60 s while the landing is confirmed but the gate is not known, so the gate appears without reselecting", async ({ page }) => {
    await page.clock.install();
    const requests = { count: 0 };
    let served = status({ state: "LANDED_CONFIRMED", source: "mock", sourceKind: "confirmed", estimate: null, landing: LANDING });
    await open(page, () => served, requests);
    await expect(statusLine(page)).toHaveAttribute("data-track-state", "LANDED_CONFIRMED");
    const afterSelect = requests.count;

    // Not on the 15 s coverage timer.
    await page.clock.runFor(20_000);
    expect(requests.count).toBe(afterSelect);

    served = status({ state: "AT_GATE", source: "mock", sourceKind: "confirmed", estimate: null, landing: LANDING, gate: "B14", terminal: "2" });
    await page.clock.runFor(41_000);
    await expect.poll(() => requests.count, { timeout: 5_000 }).toBeGreaterThan(afterSelect);
    await expect(statusLine(page)).toHaveText("At gate B14 (confirmed)");
  });

  test("deselecting stops the refetching and clears the status and cone", async ({ page }) => {
    await page.clock.install();
    const requests = { count: 0 };
    await open(page, () => status({}), requests);
    await expect.poll(() => getUncertaintyRings(page).then((r) => r.length), { timeout: 5_000 }).toBe(1);

    await page.locator(".details-panel-close").click();
    await expect(statusLine(page)).toHaveCount(0);
    await expect.poll(() => getUncertaintyRings(page).then((r) => r.length), { timeout: 5_000 }).toBe(0);
    const afterClose = requests.count;
    await page.clock.runFor(45_000);
    expect(requests.count).toBe(afterClose);
    expect(await getUncertaintyRings(page)).toHaveLength(0);
  });
});

test.describe("selected marker follows the estimate", () => {
  const selectedAt = async (page: Page) => {
    const p = (await renderedPlanes(page)).find((q) => q.icao24 === plane.icao24);
    return p ? { x: p.x, y: p.y } : null;
  };
  const expectDrawnAt = async (page: Page, lat: number, lon: number) => {
    await expect
      .poll(
        async () => {
          const drawn = await selectedAt(page);
          if (!drawn) return Infinity;
          const want = await getMapLatLngToContainerPoint(page, lat, lon);
          return Math.hypot(drawn.x - want.x, drawn.y - want.y);
        },
        { timeout: 5_000 },
      )
      .toBeLessThan(6);
  };

  test("is drawn at the estimate after each 15 s status refresh", async ({ page }) => {
    await page.clock.install();
    const requests = { count: 0 };
    let served = status({});
    await open(page, () => served, requests, { noLivePoll: true });
    await expectDrawnAt(page, served.estimate!.lat, served.estimate!.lon);

    // The cone moves on; the marker goes with it, not 72 s later.
    const next = { ...served.estimate!, lat: served.estimate!.lat + 0.01, lon: served.estimate!.lon + 0.006 };
    served = status({ estimate: next });
    const before = requests.count;
    await page.clock.runFor(15_000);
    await expect.poll(() => requests.count, { timeout: 5_000 }).toBeGreaterThan(before);
    await expectDrawnAt(page, next.lat, next.lon);
  });

  test("a status older than the shown report does not pull the marker back", async ({ page }) => {
    await open(page, () => status({ lastSeenAt: "2000-01-01T00:00:00Z" }));
    await expect(statusLine(page)).toBeVisible();
    await expectDrawnAt(page, plane.latitude, plane.longitude);
  });
});
