import { expect, test, type Page } from "@playwright/test";
import { getRouteVertices, mockFlightApi, planeTarget, renderedPlanes, setMapView, waitForMapReady, waitForPlanes, withMap } from "./helpers";
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

interface OpenOptions {
  lastReportMs: number;
  history: ReturnType<typeof position>[];
  status: TrackStatus;
  /** Opening view (app zoom 16 at the runway end by default). */
  view?: { lat: number; lon: number; zoom: number };
  /** The ref the basemap's gate point carries (E5B by default). */
  gateRef?: string;
  /** The basemap has gates from this tile zoom up only, as OpenMapTiles does (every zoom by default). */
  gateMinZoom?: number;
  /** The status request is held until this resolves. */
  holdStatus?: Promise<void>;
  /** Overrides on the last report the live endpoints serve. */
  live?: Partial<SelectedPosition & { id: number }>;
}

/** Counts the camera flights from here on (the adapter is the one object that flies). */
async function countFlights(page: Page) {
  await withMap(page, (map) => {
    const w = window as unknown as { __flights: number };
    w.__flights = 0;
    const fly = map.flyTo.bind(map);
    map.flyTo = (...a: Parameters<typeof map.flyTo>) => {
      w.__flights++;
      fly(...a);
    };
  });
}
const flights = (page: Page) => page.evaluate(() => (window as unknown as { __flights: number }).__flights);

async function open(page: Page, opts: OpenOptions) {
  await mockFlightApi(page);
  // The airport's tiles carry the gate E5B.
  await page.route(/tiles\.openfreemap\.org\/t\/(\d+)\/(\d+)\/(\d+)\.pbf/, (r) => {
    const [, z, x, y] = r.request().url().match(/\/t\/(\d+)\/(\d+)\/(\d+)\.pbf/)!;
    const body = +z >= (opts.gateMinZoom ?? 0) ? gateTile(+z, +x, +y, opts.gateRef ?? "E5B", GATE) : null;
    return r.fulfill({ body: body ?? Buffer.alloc(0), contentType: "application/x-protobuf" });
  });
  await page.route("https://tiles.openfreemap.org/planet", (r) => r.fulfill({ json: OPENFREEMAP_TILEJSON }));
  const live = position(opts.lastReportMs, opts.live);
  await page.route("**/api/flights/live*", (r) => r.fulfill({ json: [live] }));
  await page.route(`**/api/flights/${ICAO}/live*`, (r) => r.fulfill({ json: live }));
  await page.route(`**/api/flights/${ICAO}/history*`, (r) => r.fulfill({ json: opts.history }));
  await page.route(`**/api/flights/${ICAO}/status`, async (r) => {
    await opts.holdStatus;
    await r.fulfill({ json: opts.status });
  });
  await page.goto("/");
  await waitForMapReady(page);
  const view = opts.view ?? { ...RUNWAY_END, zoom: 16 };
  await setMapView(page, view.lat, view.lon, view.zoom);
  await waitForPlanes(page);
  // The plane is where it was last reported until it is selected.
  await page.waitForTimeout(500);
  await countFlights(page);
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

// ---- the one-time fly-to to a confirmed gate (#187) ----

test.describe("gate fly-to respects the user", () => {
  const OUT = { lat: RUNWAY_END.lat, lon: RUNWAY_END.lon, zoom: 12 }; // gate tiles (zoom 14) not loaded
  // An old report of a plane in the air: the selection itself does not zoom in, so what moves the
  // camera after the status arrives is the gate fly-to alone.
  const stale = () => Date.now() - HOUR;
  const flying = { onGround: false, velocityMs: 70 };

  // The selection's own flight starts when the first fresh position arrives: the status must come after it.
  const selectionFlown = async (page: Page) => {
    await expect.poll(() => flights(page), { timeout: 10_000 }).toBeGreaterThan(0);
    await settled(page);
  };
  const settled = (page: Page) => expect.poll(() => withMap(page, (m) => m.isMoving()), { timeout: 10_000 }).toBe(false);
  const camera = (page: Page) => withMap(page, (m) => ({ ...m.getCenter(), zoom: m.getZoom() }));

  test("the happy path: a gate the view cannot show yet is flown to once, and then drawn", async ({ page }) => {
    const last = stale();
    let release!: () => void;
    const holdStatus = new Promise<void>((r) => (release = r));
    await open(page, { lastReportMs: last, history: [position(last)], status: atGate(last), view: OUT, gateMinZoom: 14, holdStatus, live: flying });
    await selectionFlown(page);
    expect(await flights(page)).toBe(1);
    release();
    await expect.poll(async () => (await camera(page)).zoom, { timeout: 10_000 }).toBeCloseTo(16, 1);
    await settled(page);
    expect(await flights(page)).toBe(2); // the selection's, and the gate's, once
    await expect.poll(async () => (await selectedPlane(page))?.label, { timeout: 10_000 }).toBe("SAS086 · E5B");
  });

  test("the user panned away after selecting: the gate status does not pull the map back", async ({ page }) => {
    const last = stale();
    let release!: () => void;
    const holdStatus = new Promise<void>((r) => (release = r));
    await open(page, { lastReportMs: last, history: [position(last)], status: atGate(last), view: OUT, gateMinZoom: 14, holdStatus, live: flying });
    await selectionFlown(page);

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
    const flown = await flights(page);

    release();
    await expect(page.locator(".details-panel-status")).toContainText("At gate E5B (confirmed");
    await page.waitForTimeout(1_500); // asserting that nothing moves
    expect(await flights(page)).toBe(flown);
    const after = await camera(page);
    expect(after.lat).toBeCloseTo(before.lat, 6);
    expect(after.lon).toBeCloseTo(before.lon, 6);
    expect(after.zoom).toBeCloseTo(before.zoom, 6);
  });

  test("the gate is not in the basemap and its tiles are in view: no camera move at all", async ({ page }) => {
    const last = stale();
    let release!: () => void;
    const holdStatus = new Promise<void>((r) => (release = r));
    // Zoom 15.5: the gate tiles are loaded, and the point E5B is not in them.
    await open(page, {
      lastReportMs: last,
      history: [position(last)],
      status: atGate(last),
      view: { ...RUNWAY_END, zoom: 15.5 },
      gateRef: "Z9",
      gateMinZoom: 14,
      holdStatus,
      live: flying,
    });
    await selectionFlown(page);
    const before = await camera(page);
    const flown = await flights(page);

    release();
    await expect(page.locator(".details-panel-status")).toContainText("At gate E5B (confirmed");
    await page.waitForTimeout(1_500); // asserting that nothing moves
    expect(await flights(page)).toBe(flown);
    const after = await camera(page);
    expect(after.lat).toBeCloseTo(before.lat, 6);
    expect(after.lon).toBeCloseTo(before.lon, 6);
    expect(after.zoom).toBeCloseTo(before.zoom, 6);
    // No gate point, so the plane stays where it was reported.
    expect((await selectedPlane(page))?.label).toBe("SAS086");
  });
});
