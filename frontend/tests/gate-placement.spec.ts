import { expect, test, type Page } from "@playwright/test";
import { getRouteVertices, mockFlightApi, planeTarget, renderedPlanes, setMapView, waitForMapReady, waitForPlanes } from "./helpers";
import { OPENFREEMAP_TILEJSON } from "./fixtures/basemap";
import { GATE_STALE_MS, gateDisplay, trailFor, type TrailPoint } from "../src/map/gatePlacement";
import type { SelectedPosition, TrackStatus } from "../src/types/flight";

// #165: a flight whose gate a provider confirmed is drawn at the gate once its
// last report is old (SAS086: seen at the runway end, "At gate E5B (confirmed)"
// an hour later), and its trail is the reports only, never a stretch to the gate.

test.use({ timezoneId: "UTC" });

const ICAO = "4ca086";
const RUNWAY_END = { lat: 59.647, lon: 17.919 }; // where the last report was
const GATE = { lat: 59.6485, lon: 17.9215 }; // the E5B point in the (mocked) tile
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
    landing: { airportIcao: "ESSA", runway: "19R", touchdownAt: iso(observedAtMs - 5 * 60_000) },
    gate: "E5B",
    terminal: "5",
    confirmedAt: iso(observedAtMs + 3 * 60_000),
    ...over,
  };
}

// ---- the rule, and the trail, as plain functions ----

test.describe("gate placement rule", () => {
  const now = Date.parse("2026-11-07T12:00:00Z");
  const old = now - HOUR;
  const pos = (ms: number, over: Partial<SelectedPosition> = {}) => position(ms, over) as unknown as SelectedPosition;

  test("confirmed gate and an hour-old report: at the gate, labelled", () => {
    const d = gateDisplay(pos(old), atGate(old), now, GATE);
    expect(d).toEqual({ lat: GATE.lat, lon: GATE.lon, gate: "E5B" });
  });

  test("a fresh airborne report, an unknown gate point, another state or another aircraft: the report is drawn", () => {
    const fresh = now - 60_000;
    expect(gateDisplay(pos(fresh, { onGround: false }), atGate(fresh), now, GATE)).toBeNull();
    expect(gateDisplay(pos(old), atGate(old), now, null)).toBeNull();
    expect(gateDisplay(pos(old), atGate(old, { state: "LANDED_CONFIRMED" }), now, GATE)).toBeNull();
    expect(gateDisplay(pos(old), atGate(old, { gate: null }), now, GATE)).toBeNull();
    expect(gateDisplay(pos(old), atGate(old, { icao24: "aaaaaa" }), now, GATE)).toBeNull();
  });

  test("a fresh report on the ground at a confirmed gate is drawn at the gate; the threshold is GATE_STALE_MS", () => {
    const fresh = now - 60_000;
    expect(gateDisplay(pos(fresh, { onGround: true }), atGate(fresh), now, GATE)).not.toBeNull();
    const justFresh = now - GATE_STALE_MS + 1_000;
    expect(gateDisplay(pos(justFresh, { onGround: false }), atGate(justFresh), now, GATE)).toBeNull();
    const justStale = now - GATE_STALE_MS - 1_000;
    expect(gateDisplay(pos(justStale, { onGround: false }), atGate(justStale), now, GATE)).not.toBeNull();
  });

  test("a report well after the gate-in is the plane moving again: drawn where it is", () => {
    const status = atGate(old, { confirmedAt: iso(old - 30 * 60_000) });
    expect(gateDisplay(pos(old), status, now, GATE)).toBeNull();
  });

  test("a gate of that ref far from where the plane was seen is another airport's", () => {
    expect(gateDisplay(pos(old), atGate(old), now, { lat: GATE.lat + 1, lon: GATE.lon })).toBeNull();
  });

  const reports: TrailPoint[] = [
    { lat: 59.7, lon: 17.8, observedAt: iso(old - 20 * 60_000) },
    { lat: 59.68, lon: 17.86, observedAt: iso(old - 10 * 60_000) },
    { lat: RUNWAY_END.lat, lon: RUNWAY_END.lon, observedAt: iso(old) },
  ];

  test("the trail is the reports in time order, even handed over out of order, and none after the last observation", () => {
    const shuffled = [reports[2], reports[0], { lat: 1, lon: 1, observedAt: iso(old + 5 * 60_000) }, reports[1]];
    const tip = { latitude: RUNWAY_END.lat, longitude: RUNWAY_END.lon, observedAt: iso(old) };
    expect(trailFor(shuffled, tip, null, now)).toEqual(reports.map((p) => [p.lat, p.lon]));
  });

  test("drawn at the gate with an old last report: no trail at all, and never a stretch to the gate", () => {
    const tip = { latitude: RUNWAY_END.lat, longitude: RUNWAY_END.lon, observedAt: iso(old) };
    const display = { lat: GATE.lat, lon: GATE.lon, gate: "E5B" };
    expect(trailFor(reports, tip, display, now)).toEqual([]);
    // A recent last report: the real reports, ending at the last one, not at the gate.
    const recent = reports.map((p, i) => ({ ...p, observedAt: iso(now - (3 - i) * 60_000) }));
    const recentTip = { latitude: RUNWAY_END.lat, longitude: RUNWAY_END.lon, observedAt: recent[2].observedAt };
    const trail = trailFor(recent, recentTip, display, now);
    expect(trail).toEqual(recent.map((p) => [p.lat, p.lon]));
    expect(trail).not.toContainEqual([GATE.lat, GATE.lon]);
  });

  test("not at a gate: an estimated tip still extends the trail, as before", () => {
    const estimate = { latitude: 59.6, longitude: 17.95, observedAt: iso(old) };
    expect(trailFor(reports, estimate, null, now).at(-1)).toEqual([59.6, 17.95]);
  });
});

// ---- the app, with the gate as a point in the basemap's own vector tiles ----

// A minimal Mapbox Vector Tile: one `aeroway` layer holding one point, class=gate, ref=<ref>.
function varint(n: number): number[] {
  const out: number[] = [];
  while (n > 0x7f) {
    out.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n);
  return out;
}
const field = (num: number, wire: number) => varint((num << 3) | wire);
const lenDelimited = (num: number, bytes: number[]) => [...field(num, 2), ...varint(bytes.length), ...bytes];
const text = (s: string) => [...Buffer.from(s, "utf8")];
const zigzag = (n: number) => (n << 1) ^ (n >> 31);

function gateTile(z: number, x: number, y: number, ref: string, at: { lat: number; lon: number }): Buffer | null {
  const n = 2 ** z;
  const fx = ((at.lon + 180) / 360) * n;
  const latRad = (at.lat * Math.PI) / 180;
  const fy = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
  if (Math.floor(fx) !== x || Math.floor(fy) !== y) return null;
  const extent = 4096;
  const px = Math.floor((fx - x) * extent);
  const py = Math.floor((fy - y) * extent);
  const feature = [
    ...lenDelimited(2, [...varint(0), ...varint(0), ...varint(1), ...varint(1)]), // tags: class=gate, ref=<ref>
    ...field(3, 0), ...varint(1), // POINT
    ...lenDelimited(4, [...varint(9), ...varint(zigzag(px)), ...varint(zigzag(py))]), // MoveTo(1)
  ];
  const layer = [
    ...field(15, 0), ...varint(2),
    ...lenDelimited(1, text("aeroway")),
    ...lenDelimited(2, feature),
    ...lenDelimited(3, text("class")),
    ...lenDelimited(3, text("ref")),
    ...lenDelimited(4, lenDelimited(1, text("gate"))),
    ...lenDelimited(4, lenDelimited(1, text(ref))),
    ...field(5, 0), ...varint(extent),
  ];
  return Buffer.from(lenDelimited(3, layer));
}

async function open(page: Page, opts: { lastReportMs: number; history: ReturnType<typeof position>[]; status: TrackStatus }) {
  await mockFlightApi(page);
  // The airport's tiles carry the gate E5B.
  await page.route(/tiles\.openfreemap\.org\/t\/(\d+)\/(\d+)\/(\d+)\.pbf/, (r) => {
    const [, z, x, y] = r.request().url().match(/\/t\/(\d+)\/(\d+)\/(\d+)\.pbf/)!;
    const body = gateTile(+z, +x, +y, "E5B", GATE);
    return r.fulfill({ body: body ?? Buffer.alloc(0), contentType: "application/x-protobuf" });
  });
  await page.route("https://tiles.openfreemap.org/planet", (r) => r.fulfill({ json: OPENFREEMAP_TILEJSON }));
  const live = position(opts.lastReportMs);
  await page.route("**/api/flights/live*", (r) => r.fulfill({ json: [live] }));
  await page.route(`**/api/flights/${ICAO}/live*`, (r) => r.fulfill({ json: live }));
  await page.route(`**/api/flights/${ICAO}/history*`, (r) => r.fulfill({ json: opts.history }));
  await page.route(`**/api/flights/${ICAO}/status`, (r) => r.fulfill({ json: opts.status }));
  await page.goto("/");
  await waitForMapReady(page);
  await setMapView(page, RUNWAY_END.lat, RUNWAY_END.lon, 16);
  await waitForPlanes(page);
  // The plane is where it was last reported until it is selected.
  await page.waitForTimeout(500);
  await planeTarget(page, ICAO).click();
  await page.getByText(`ICAO24 ${ICAO.toUpperCase()}`).waitFor({ timeout: 5_000 });
}

const selectedPlane = async (page: Page) => (await renderedPlanes(page)).find((p) => p.icao24 === ICAO && p.selected);

test.describe("confirmed gate on the map", () => {
  test("SAS086: an hour-old runway-end report is drawn at gate E5B with the gate in its label, and no stale trail", async ({ page }) => {
    const last = Date.now() - HOUR;
    const history = [
      position(last - 20 * 60_000, { latitude: 59.69, longitude: 17.86, onGround: false, velocityMs: 70 }),
      position(last - 10 * 60_000, { latitude: 59.66, longitude: 17.9, onGround: false, velocityMs: 60 }),
      position(last),
    ];
    await open(page, { lastReportMs: last, history, status: atGate(last) });

    await expect.poll(async () => (await selectedPlane(page))?.label, { timeout: 10_000 }).toBe("SAS086 · E5B");
    const plane = (await selectedPlane(page))!;
    expect(plane.lat).toBeCloseTo(GATE.lat, 3);
    expect(plane.lon).toBeCloseTo(GATE.lon, 3);
    // The last report is 1 h old: the trail would end at the runway end, away from the plane.
    await expect.poll(() => getRouteVertices(page)).toEqual([]);
    // The panel is unchanged: it still says what the provider says, and how old the report is.
    await expect(page.locator(".details-panel-status")).toContainText("At gate E5B (confirmed");
  });

  test("a recent last report: at the gate, trail only through reported positions, in time order, ending at the last report", async ({ page }) => {
    const last = Date.now() - 4 * 60_000;
    const reported = [
      position(last - 3 * 60_000, { latitude: 59.69, longitude: 17.86, onGround: false, velocityMs: 70 }),
      position(last - 2 * 60_000, { latitude: 59.66, longitude: 17.9, onGround: false, velocityMs: 60 }),
      position(last),
    ];
    // The server hands the history over newest first; the trail is drawn in time order regardless.
    await open(page, { lastReportMs: last, history: [...reported].reverse(), status: atGate(last, { confirmedAt: iso(last + 60_000) }) });

    await expect.poll(async () => (await selectedPlane(page))?.label, { timeout: 10_000 }).toBe("SAS086 · E5B");
    await expect.poll(async () => (await getRouteVertices(page)).length).toBeGreaterThan(2);
    const vertices = await getRouteVertices(page);
    // Every reported point is on the line, in time order, and the line ends at the last report: not at the gate.
    let from = 0;
    for (const r of reported) {
      const i = vertices.findIndex((v, k) => k >= from && Math.abs(v.lat - r.latitude) < 1e-6 && Math.abs(v.lon - r.longitude) < 1e-6);
      expect(i, `reported point ${r.latitude},${r.longitude} is on the trail after the previous one`).toBeGreaterThanOrEqual(from);
      from = i;
    }
    const end = vertices[vertices.length - 1];
    expect(end.lat).toBeCloseTo(RUNWAY_END.lat, 6);
    expect(end.lon).toBeCloseTo(RUNWAY_END.lon, 6);
  });

  test("not confirmed at a gate: the plane is drawn where it was last reported", async ({ page }) => {
    const last = Date.now() - HOUR;
    await open(page, { lastReportMs: last, history: [position(last)], status: atGate(last, { state: "LANDED_CONFIRMED", gate: null }) });
    await page.waitForTimeout(1_000); // asserting that nothing moves
    const plane = (await selectedPlane(page))!;
    expect(plane.lat).toBeCloseTo(RUNWAY_END.lat, 5);
    expect(plane.label).toBe("SAS086");
  });
});
