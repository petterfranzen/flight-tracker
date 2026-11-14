import { expect, test, type Page } from "@playwright/test";
import { mockFlightApi, planeTarget, renderedPlanes, setMapView, waitForMapReady, waitForPlanes, withMap } from "./helpers";
import type { SelectedPosition, TrackStatus } from "../src/types/flight";

// #301: selecting a plane whose gate a provider has since confirmed must centre on the
// point the map *draws* (the gate), not on the raw last report. The last report is at the
// runway end (AT_GATE E5B); the marker is drawn at the gate. Centring on the report left
// the marker off screen on a 390 px phone, and renderedPlanes() showed no selected plane.
//
// The gate resolves from the build-time index (ESSA is one of its airports), so no tile
// mock is needed: it answers before the basemap's gate layer ever gets a chance.

test.use({ viewport: { width: 390, height: 844 }, timezoneId: "UTC" });

const ICAO = "4ca086";
const RUNWAY_END = { lat: 59.647, lon: 17.919 };
const HOUR = 3_600_000;

const iso = (ms: number) => new Date(ms).toISOString();

function position(observedAtMs: number, over: Partial<SelectedPosition & { id: number }> = {}) {
  return {
    id: 1,
    icao24: ICAO,
    callsign: "SAS086",
    observedAt: iso(observedAtMs),
    latitude: RUNWAY_END.lat,
    longitude: RUNWAY_END.lon,
    altitudeM: null,
    velocityMs: 6,
    headingDeg: 190,
    verticalRateMs: null,
    onGround: true,
    agentSource: "opensky",
    ...over,
  };
}

const landingAt = (airportIcao: string, observedAtMs: number) => ({
  airportIcao,
  runway: "19R",
  touchdownAt: iso(observedAtMs - 5 * 60_000),
});

function atGate(observedAtMs: number, over: Partial<TrackStatus> = {}): TrackStatus {
  return {
    icao24: ICAO,
    state: "AT_GATE",
    confidence: 1,
    source: "swedavia",
    sourceKind: "confirmed",
    lastSeenAt: iso(observedAtMs),
    lastSeenLat: RUNWAY_END.lat,
    lastSeenLon: RUNWAY_END.lon,
    estimate: null,
    landing: landingAt("ESSA", observedAtMs),
    gate: "E5B",
    terminal: "5",
    confirmedAt: iso(observedAtMs + 3 * 60_000),
    ...over,
  };
}

/** A coverage gap: no gate, but the server dead-reckons where the plane probably is. */
function coverageLost(observedAtMs: number, at: { lat: number; lon: number }): TrackStatus {
  return {
    icao24: ICAO,
    state: "COVERAGE_LOST",
    confidence: 0.6,
    source: "physics",
    sourceKind: "inferred",
    lastSeenAt: iso(observedAtMs),
    lastSeenLat: RUNWAY_END.lat,
    lastSeenLon: RUNWAY_END.lon,
    estimate: { lat: at.lat, lon: at.lon, radiusM: 4_000, at: iso(observedAtMs), landingProbability: 0.4 },
    landing: landingAt("ESSA", observedAtMs),
    gate: null,
    terminal: null,
    confirmedAt: null,
  };
}

const settled = (page: Page) => expect.poll(() => withMap(page, (m) => m.isMoving()), { timeout: 10_000 }).toBe(false);
const camera = (page: Page) => withMap(page, (map) => ({ ...map.getCenter(), zoom: map.getZoom() }));
/**
 * The camera once it has stopped changing *on its own* — the selection's fly-to, the
 * mobile sheet mounting and panning to keep the marker above it. Sampling until two
 * readings agree is a wait for state: the selection's own move is not the pan under
 * test, and a baseline taken mid-move would read the app's own camera work as one.
 */
async function settleCamera(page: Page) {
  let last = await camera(page);
  await expect
    .poll(
      async () => {
        const now = await camera(page);
        const quiet = Math.abs(now.lat - last.lat) < 1e-7 && Math.abs(now.lon - last.lon) < 1e-7 && Math.abs(now.zoom - last.zoom) < 1e-7;
        last = now;
        return quiet;
      },
      { timeout: 20_000 },
    )
    .toBe(true);
  return last;
}
const selectedPlane = async (page: Page) => (await renderedPlanes(page)).find((p) => p.icao24 === ICAO && p.selected);

/** The gate-placement harness, on ESSA: the plane is selected with its report at the runway end. */
async function open(page: Page, opts: { lastReportMs: number; status: TrackStatus; holdStatus?: Promise<void> }) {
  await mockFlightApi(page);
  const live = position(opts.lastReportMs);
  await page.route("**/api/flights/live*", (r) => r.fulfill({ json: [live] }));
  await page.route(`**/api/flights/${ICAO}/live*`, (r) => r.fulfill({ json: live }));
  await page.route(`**/api/flights/${ICAO}/history*`, (r) => r.fulfill({ json: [live] }));
  await page.route(`**/api/flights/${ICAO}/status`, async (r) => {
    await opts.holdStatus;
    await r.fulfill({ json: opts.status });
  });
  await page.goto("/");
  await waitForMapReady(page);
  await setMapView(page, RUNWAY_END.lat, RUNWAY_END.lon, 12);
  await waitForPlanes(page);
  // Wait for the state the click needs rather than a fixed sleep: our own plane drawn,
  // and the view done moving (a click aimed at where the marker was mid-move lands nowhere).
  await expect.poll(async () => (await renderedPlanes(page)).some((p) => p.icao24 === ICAO), { timeout: 10_000 }).toBe(true);
  await settled(page);
  // The 390 px layout hides the dossier's ICAO24 line until the sheet is tapped, so the
  // selection is confirmed by the drawn marker below, not by that text.
  await planeTarget(page, ICAO).click();
}

test.describe("selecting a plane centres on the drawn point", () => {
  test("at its gate: the marker is panned into view, labelled with the gate", async ({ page }) => {
    const last = Date.now() - HOUR;
    await open(page, { lastReportMs: last, status: atGate(last) });

    // Nothing re-centres on a fixed sleep: wait for the draw *and* the camera to settle.
    const box = (await page.locator(".map-container").boundingBox())!;
    await expect
      .poll(
        async () => {
          const p = await selectedPlane(page);
          if (!p) return "no selected plane drawn";
          if (p.label !== "SAS086 · E5B") return `label ${p.label}`;
          const inside = p.x >= box.x && p.x <= box.x + box.width && p.y >= box.y && p.y <= box.y + box.height;
          return inside ? "inside" : `outside x=${Math.round(p.x)} y=${Math.round(p.y)} box=${JSON.stringify(box)}`;
        },
        { timeout: 10_000 },
      )
      .toBe("inside");
  });

  test("the user panned away after selecting: the gate status does not pull the map back", async ({ page }) => {
    const last = Date.now() - HOUR;
    let release!: () => void;
    const holdStatus = new Promise<void>((r) => (release = r));
    await open(page, { lastReportMs: last, status: atGate(last), holdStatus });
    await settled(page);

    const box = (await page.locator(".map-container").boundingBox())!;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 40, y + 20, { steps: 4 });
    await page.mouse.move(x + 120, y + 60, { steps: 4 });
    await page.mouse.up();
    await settled(page);
    const before = await camera(page);

    // The status lands now, moving the marker to the gate; the camera must stay put.
    release();
    await expect
      .poll(async () => await page.locator(".details-panel-status").textContent(), { timeout: 10_000 })
      .toContain("At gate E5B");
    await page.waitForTimeout(1_500); // asserting that nothing moves
    const after = await camera(page);
    expect(after.lat).toBeCloseTo(before.lat, 6);
    expect(after.lon).toBeCloseTo(before.lon, 6);
    expect(after.zoom).toBeCloseTo(before.zoom, 6);
  });

  test("no gate: a position tick moving the plane off screen does not pan the map", async ({ page }) => {
    const last = Date.now() - HOUR;
    // ~6 km east of the view centre: outside the 390 px viewport at zoom 12 (its half
    // width is ~3.8 km), inside the margin the marker is still drawn in.
    const drift = { lat: RUNWAY_END.lat, lon: RUNWAY_END.lon + 0.11 };
    let releaseStatus!: () => void;
    const holdStatus = new Promise<void>((r) => (releaseStatus = r));
    let push: ((m: unknown) => void) | null = null;

    // Everything but the status answers as usual, so the selection settles exactly the way
    // the other specs leave it; the status is held so this spec decides when it lands.
    // The position both feeds serve moves with the aircraft: a snapshot that lands after the
    // pushed report must agree with it, or it would pull the marker back (the mocks agree
    // the way the server does — every endpoint serves the same estimated position).
    await mockFlightApi(page);
    const report = position(last);
    let served = report;
    await page.route("**/api/flights/live*", (r) => r.fulfill({ json: [served] }));
    await page.route(`**/api/flights/${ICAO}/live*`, (r) => r.fulfill({ json: served }));
    await page.route(`**/api/flights/${ICAO}/history*`, (r) => r.fulfill({ json: [report] }));
    await page.route(`**/api/flights/${ICAO}/status`, async (r) => {
      await holdStatus;
      await r.fulfill({ json: coverageLost(last, drift) });
    });
    // The live feed, registered after mockFlightApi's own accept-only route so this one
    // serves: the next report is pushed by the feed, the way a real one arrives.
    await page.routeWebSocket("**/ws/live", (ws) => {
      push = (m) => ws.send(JSON.stringify(m));
    });
    await page.goto("/");
    await waitForMapReady(page);
    await setMapView(page, RUNWAY_END.lat, RUNWAY_END.lon, 12);
    await waitForPlanes(page);
    await expect.poll(async () => (await renderedPlanes(page)).some((p) => p.icao24 === ICAO), { timeout: 10_000 }).toBe(true);
    await settled(page);
    await planeTarget(page, ICAO).click();

    // Selected, drawn at its report, in view, and the app's own camera work is done.
    await expect.poll(async () => (await selectedPlane(page)) !== undefined, { timeout: 10_000 }).toBe(true);
    const focusButton = page.locator(".details-panel-focus-toggle"); // the app's own "it left the view"
    await expect(focusButton).toHaveCount(0);
    const before = await settleCamera(page);

    // The next report, ~6 km away: an ordinary position tick, and createFollowSelected's
    // "an ordinary position tick does not recenter" is what must hold here.
    await expect.poll(() => push !== null, { timeout: 10_000 }).toBe(true);
    const moved = position(Date.now(), { latitude: drift.lat, longitude: drift.lon });
    served = moved; // the feeds follow the aircraft from here on
    push!({ ...moved });
    await expect(focusButton).toHaveCount(1, { timeout: 15_000 });
    const afterMove = await camera(page);
    expect(afterMove.lat).toBeCloseTo(before.lat, 6);
    expect(afterMove.lon).toBeCloseTo(before.lon, 6);

    // The gate-less status lands now, with the marker already off screen: it must not pull
    // the map back either (the status is refreshed on a timer, so this would repeat).
    releaseStatus();
    await page.waitForTimeout(1_500); // asserting that nothing moves
    const after = await camera(page);
    expect(after.lat).toBeCloseTo(before.lat, 6);
    expect(after.lon).toBeCloseTo(before.lon, 6);
    expect(after.zoom).toBeCloseTo(before.zoom, 6);
  });
});
