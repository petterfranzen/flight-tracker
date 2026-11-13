import { expect, test, type Page } from "@playwright/test";
import { getRouteVertices, mockFlightApi, planeTarget, renderedPlanes, setMapView, waitForMapReady, waitForPlanes, withMap } from "./helpers";
import { OPENFREEMAP_TILEJSON } from "./fixtures/basemap";
import { displayedPosition, GATE_MAX_DISTANCE_M, GATE_STALE_MS, gateDisplay, trailFor, type TrailPoint } from "../src/map/gatePlacement";
import { gateFromIndex, gateIndexReady, loadGateIndex, nearestGateOrStandFromIndex, nearestStandFromIndex, normalizeGateRef } from "../src/map/gateIndex";
import { GATE_INDEX } from "../src/map/gateIndexData";
import type { SelectedPosition, TrackStatus } from "../src/types/flight";

// #165: a flight whose gate a provider confirmed is drawn at the gate once its
// last report is old (SAS086: seen at the runway end, "At gate E5B (confirmed)"
// an hour later), and its trail is the reports only, never a stretch to the gate.
//
// #244: the gate's coordinate now comes from the build-time OSM index
// (src/map/gateIndexData.ts, written by scripts/build-gate-index.mjs) before the
// basemap's own gate point, so it resolves at any zoom. The tests that drive
// the basemap path use an airport the index does not carry (see AIRPORT).

test.use({ timezoneId: "UTC" });

// The gate index is its own chunk (gateIndex.ts): load it before any pure lookup.
test.beforeAll(() => loadGateIndex());

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

// The mocked basemap carries the gate point, so the tests that drive *that*
// path must use an airport the build-time index does NOT carry — otherwise
// findGate answers from the index before it ever queries a tile. ESPA (Luleå)
// is one of many airports absent from scripts/build-gate-index.mjs's eight.
// The index path has its own specs below, on ESSA.
const AIRPORT = "ESPA";
const landingAt = (airportIcao: string, observedAtMs: number) => ({ airportIcao, runway: "19R", touchdownAt: iso(observedAtMs - 5 * 60_000) });

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
    landing: landingAt(AIRPORT, observedAtMs),
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
    expect(d).toEqual({ lat: GATE.lat, lon: GATE.lon, gate: "E5B", approximate: false });
  });

  test("a fresh airborne report, an unknown gate point, another state or another aircraft: the report is drawn", () => {
    const fresh = now - 60_000;
    expect(gateDisplay(pos(fresh, { onGround: false }), atGate(fresh), now, GATE)).toBeNull();
    expect(gateDisplay(pos(old), atGate(old), now, null)).toBeNull();
    expect(gateDisplay(pos(old), atGate(old, { state: "COVERAGE_LOST" }), now, GATE)).toBeNull();
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

  // #245: a provider that confirmed the landing at a named gate knows where the
  // plane is, so LANDED_CONFIRMED with a gate is drawn at it too. But
  // `confirmedAt` is the touchdown time, not a gate-in: a fresh report is the
  // plane taxiing in, and a report long after touchdown is still the arrival.
  test("LANDED_CONFIRMED with a gate: at the gate once the report is stale, never from a fresh one", () => {
    const stale = now - HOUR;
    const landed = atGate(stale, { state: "LANDED_CONFIRMED", confirmedAt: iso(stale - 30 * 60_000) });
    expect(gateDisplay(pos(stale), landed, now, GATE)).toEqual({ lat: GATE.lat, lon: GATE.lon, gate: "E5B", approximate: false });
    // A fresh on-ground report is the plane taxiing in, not parked: drawn where it is.
    const fresh = now - 60_000;
    const taxiing = atGate(fresh, { state: "LANDED_CONFIRMED", confirmedAt: iso(fresh - 5 * 60_000) });
    expect(gateDisplay(pos(fresh, { onGround: true }), taxiing, now, GATE)).toBeNull();
    // No gate ref: nothing to move to.
    expect(gateDisplay(pos(stale), atGate(stale, { state: "LANDED_CONFIRMED", gate: null }), now, GATE)).toBeNull();
  });

  test("a fresh on-ground report is never replaced by a guess; a mapped gate still is", () => {
    const fresh = now - 60_000;
    const guess = { lat: GATE.lat, lon: GATE.lon, approximate: true };
    // The plane is taxiing where the report says it is: a guess has nothing to add.
    expect(gateDisplay(pos(fresh, { onGround: true }), atGate(fresh), now, guess)).toBeNull();
    // The gate's own point is knowledge, not a guess, and still wins.
    expect(gateDisplay(pos(fresh, { onGround: true }), atGate(fresh), now, GATE)).not.toBeNull();
  });

  // #245: a gate the index does not carry is drawn at a guessed point in the
  // airport's terminal area, and the label says so.
  test("a terminal-area guess is labelled \"Gate <ref>\"; a mapped gate keeps the bare ref", () => {
    const guess = { lat: GATE.lat, lon: GATE.lon, gate: "E5B", approximate: true };
    expect(displayedPosition(pos(old), guess).callsign).toBe("SAS086 · Gate E5B");
    expect(displayedPosition(pos(old), { ...guess, approximate: false }).callsign).toBe("SAS086 · E5B");
    expect(gateDisplay(pos(old), atGate(old), now, { lat: GATE.lat, lon: GATE.lon, approximate: true })).toEqual({
      lat: GATE.lat,
      lon: GATE.lon,
      gate: "E5B",
      approximate: true,
    });
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
    const display = { lat: GATE.lat, lon: GATE.lon, gate: "E5B", approximate: false };
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
    // The marker carries the state the backend stamps for a plane a provider has put
    // at a gate (LiveStateStore.stateOf): the landed-display rule keeps such a plane
    // on the map however old its last report is.
    await open(page, { lastReportMs: last, history, status: atGate(last), live: { state: "AT_GATE" } });

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
    await open(page, { lastReportMs: last, history: [...reported].reverse(), status: atGate(last, { confirmedAt: iso(last + 60_000) }), live: { state: "AT_GATE" } });

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

  // #245: 87 (T2), F58 and F62 (T5) are confirmed ARN gates that are in neither
  // OSM's gate layer nor the index. The plane used to sit at its estimate with
  // the trail drawn to it; it is now drawn at the nearest indexed gate or stand
  // of the landing airport — the terminal area — labelled with the provider's
  // ref, and the trail still never runs on to it.
  test("a gate the index does not carry: drawn at the airport's terminal area, labelled \"Gate 87\", no trail", async ({ page }) => {
    const last = Date.now() - HOUR;
    const expected = nearestGateOrStandFromIndex("ESSA", RUNWAY_END, GATE_MAX_DISTANCE_M)!;
    await open(page, {
      lastReportMs: last,
      history: [position(last)],
      status: atGate(last, { gate: "87", terminal: "2", landing: landingAt("ESSA", last) }),
      live: { state: "AT_GATE" },
      gateMinZoom: 99, // no gate point in any tile: only the index can answer
    });

    await expect.poll(async () => (await selectedPlane(page))?.label, { timeout: 30_000 }).toBe("SAS086 · Gate 87");
    const plane = (await selectedPlane(page))!;
    expect(plane.lat).toBeCloseTo(expected.lat, 4);
    expect(plane.lon).toBeCloseTo(expected.lon, 4);
    // Not left at the runway end where the last report was.
    expect(Math.abs(plane.lat - RUNWAY_END.lat) + Math.abs(plane.lon - RUNWAY_END.lon)).toBeGreaterThan(0.001);
    // An hour-old report: the trail would end at the runway end, away from the plane.
    await expect.poll(() => getRouteVertices(page), { timeout: 30_000 }).toEqual([]);
    // The dossier says the point is a guess, not the stand.
    await expect(page.locator(".details-panel-status")).toContainText("approx. position");
  });

  // #245: the guess is recomputed on every resolve, never frozen at the first
  // one: a plane that lands at the runway end and then taxis to a pier must not
  // keep the marker back at the runway-side stand.
  test("the guess follows the plane: a later lastSeen moves the drawn point", async ({ page }) => {
    await page.clock.install(); // time still flows; runFor jumps the 60 s landed refetch below
    const last = Date.now() - HOUR;
    const runwayStand = nearestGateOrStandFromIndex("ESSA", RUNWAY_END, GATE_MAX_DISTANCE_M)!;
    const parked = gateFromIndex("ESSA", "33", RUNWAY_END)!;
    const opts = {
      lastReportMs: last,
      history: [position(last)],
      status: atGate(last, {
        state: "LANDED_CONFIRMED",
        gate: "87",
        landing: landingAt("ESSA", last),
        confirmedAt: iso(last - 30 * 60_000),
      }),
      live: { state: "AT_GATE" },
      gateMinZoom: 99,
    };
    await open(page, opts);
    // Count the landed refetches from here on, and serve the moving lastSeen.
    let requests = 0;
    let served = opts.status;
    await page.route(`**/api/flights/${ICAO}/status`, (r) => {
      requests++;
      return r.fulfill({ json: served });
    });

    // First guess: the nearest indexed gate or stand to the runway-end report.
    await expect.poll(async () => (await selectedPlane(page))?.label, { timeout: 30_000 }).toBe("SAS086 · Gate 87");
    let plane = (await selectedPlane(page))!;
    expect(plane.lat).toBeCloseTo(runwayStand.lat, 4);
    expect(plane.lon).toBeCloseTo(runwayStand.lon, 4);

    // It taxied to a pier stand; the 60 s landed refetch brings the new lastSeen,
    // which lands within the 60 m stand snap, so the label drops the guess marker.
    served = { ...opts.status, lastSeenLat: parked.lat, lastSeenLon: parked.lon };
    // fastForward, not runFor: it fires each due timer once instead of replaying
    // 61 s of animation frames, which a map spec cannot afford.
    await page.clock.fastForward(61_000);
    await expect.poll(async () => (await selectedPlane(page))?.label, { timeout: 30_000 }).toBe("SAS086 · 87");
    plane = (await selectedPlane(page))!;
    expect(plane.lat).toBeCloseTo(parked.lat, 4);
    expect(plane.lon).toBeCloseTo(parked.lon, 4);
  });

  // #245: the same knowledge as AT_GATE, so a confirmed landing whose provider
  // named a gate is drawn at the gate too. The report is 30 min after touchdown,
  // which the AT_GATE later-movement rule would have rejected.
  test("LANDED_CONFIRMED with a known gate: drawn at the gate, no stale trail", async ({ page }) => {
    const last = Date.now() - HOUR;
    const gate = gateFromIndex("ESSA", "E5B", RUNWAY_END)!;
    const at = { lat: gate.lat - 0.0015, lon: gate.lon };
    await open(page, {
      lastReportMs: last,
      history: [position(last, { latitude: at.lat, longitude: at.lon })],
      live: { latitude: at.lat, longitude: at.lon, state: "AT_GATE" },
      status: atGate(last, {
        state: "LANDED_CONFIRMED",
        lastSeenLat: at.lat,
        lastSeenLon: at.lon,
        confirmedAt: iso(last - 30 * 60_000), // touchdown, not a gate-in
        landing: landingAt("ESSA", last),
      }),
      view: { ...at, zoom: 16 },
      gateMinZoom: 99,
    });

    await expect.poll(async () => (await selectedPlane(page))?.label, { timeout: 30_000 }).toBe("SAS086 · E5B");
    const plane = (await selectedPlane(page))!;
    expect(plane.lat).toBeCloseTo(gate.lat, 4);
    expect(plane.lon).toBeCloseTo(gate.lon, 4);
    await expect.poll(() => getRouteVertices(page), { timeout: 30_000 }).toEqual([]);
  });

  test("not confirmed at a gate: the plane is drawn where it was last reported", async ({ page }) => {
    // A provider-confirmed landing with no gate: old enough that a *gate* would move
    // the plane (GATE_STALE_MS, 10 min), but inside the landed-display window
    // (LANDED_HIDE_MS, 30 min), so the plane is on the map and nothing moves it.
    const last = Date.now() - 20 * 60_000;
    await open(page, { lastReportMs: last, history: [position(last)], status: atGate(last, { state: "LANDED_CONFIRMED", gate: null }), live: { state: "LANDED_CONFIRMED" } });
    // Poll for the drawn marker rather than sleeping at it: a fixed wait is a
    // race on a loaded box, and the position assertion below is what says
    // nothing moved it.
    await expect.poll(async () => (await selectedPlane(page))?.label, { timeout: 30_000 }).toBe("SAS086");
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

  // #245: a terminal-area guess is not a resolved gate. It must not stop the
  // one-time fly-to, which is the only way the airport's tiles get loaded.
  test("a terminal-area guess does not block the one-time fly-to", async ({ page }) => {
    const last = stale();
    let release!: () => void;
    const holdStatus = new Promise<void>((r) => (release = r));
    await open(page, {
      lastReportMs: last,
      history: [position(last)],
      status: atGate(last, { gate: "87", landing: landingAt("ESSA", last) }),
      view: OUT,
      gateMinZoom: 14,
      holdStatus,
      live: flying,
    });
    await selectionFlown(page);
    expect(await flights(page)).toBe(1);

    release();
    await expect.poll(async () => (await camera(page)).zoom, { timeout: 30_000 }).toBeCloseTo(16, 1);
    // The flight itself can outlast `settled`'s own 10 s budget on a loaded box.
    await expect.poll(() => withMap(page, (m) => m.isMoving()), { timeout: 30_000 }).toBe(false);
    expect(await flights(page)).toBe(2); // the selection's, and the gate's, once
    await expect.poll(async () => (await selectedPlane(page))?.label, { timeout: 30_000 }).toBe("SAS086 · Gate 87");
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

// ---- the build-time OSM gate index: a gate resolves at any zoom ----
//
// On main, findGate reads only the basemap's own `aeroway` gate points, which
// ship from tile zoom 14 up (app zoom 15): below that the lookup is empty, and
// the app can only fall back to its one-time fly-to. The committed index
// (src/map/gateIndexData.ts, from OSM) carries ESSA E5B with no tile at all, so
// the gate resolves while the view is at app zoom 12 — and the index wins over
// a tile point when the basemap has one, because it is the fuller OSM snapshot.

test.describe("gate index: a gate resolves with no gate tile loaded", () => {
  // The index is its own chunk (gateIndex.ts): load it before the pure lookups.
  test.beforeAll(() => loadGateIndex());
  const AT_RUNWAY = { lat: RUNWAY_END.lat, lon: RUNWAY_END.lon };
  const GATE_IDX = () => gateFromIndex("ESSA", "E5B", AT_RUNWAY)!;
  // The plane's last report: a couple of hundred metres from the gate, so both
  // it and the gate sit inside the view at every zoom these tests use (the map
  // draws the selected plane only where the viewport can render it).
  const nearGate = () => ({ lat: GATE_IDX().lat - 0.0015, lon: GATE_IDX().lon });

  test("the index carries ESSA E5B and the ref normaliser is tolerant", async () => {
    await loadGateIndex();
    expect(gateIndexReady()).toBe(true);
    expect(normalizeGateRef("E5B")).toBe("E5B");
    expect(normalizeGateRef("d18")).toBe("D18");
    expect(normalizeGateRef(" Gate D18 ")).toBe("D18");
    expect(normalizeGateRef("e5 b")).toBe("E5B");
    expect(gateFromIndex("ESSA", "E5B", AT_RUNWAY)).not.toBeNull();
    // A remote stand's ref resolves too (parking_position, not a gate).
    expect(gateFromIndex("ESSA", "33", AT_RUNWAY)).not.toBeNull();
    // A ref the airport does not carry, and an airport the index does not carry.
    expect(gateFromIndex("ESSA", "ZZ99", AT_RUNWAY)).toBeNull();
    expect(gateFromIndex("ESPA", "E5B", AT_RUNWAY)).toBeNull();
  });

  test("a ref that names several objects resolves to the one nearest the plane", () => {
    // EGLL's A-pier refs sit at two terminals: taking the first would put a T2
    // arrival at T5, about 2.6 km away. The nearest to the plane's last report wins.
    const points = GATE_INDEX.EGLL.gates.A16;
    expect(points.length).toBeGreaterThan(1);
    const [lonA, latA] = points[0];
    const [lonB, latB] = points[points.length - 1];
    expect(lonA === lonB && latA === latB).toBe(false);
    expect(gateFromIndex("EGLL", "A16", { lat: latA, lon: lonA })).toEqual({ lat: latA, lon: lonA });
    expect(gateFromIndex("EGLL", "A16", { lat: latB, lon: lonB })).toEqual({ lat: latB, lon: lonB });
  });

  test("a ref in both the gate and stand lists resolves to the stand", () => {
    // ESSA 53 is mapped as both an aeroway=gate and a parking_position stand; a
    // provider naming it means the stand, so the stand's point wins.
    const stand = GATE_INDEX.ESSA.stands["53"];
    const gate = GATE_INDEX.ESSA.gates["53"];
    expect(stand.length).toBeGreaterThan(0);
    expect(gate.length).toBeGreaterThan(0);
    const near = { lat: stand[0][1], lon: stand[0][0] };
    expect(gateFromIndex("ESSA", "53", near)).toEqual({ lat: stand[0][1], lon: stand[0][0] });
    expect(gateFromIndex("ESSA", "53", near)).not.toEqual({ lat: gate[0][1], lon: gate[0][0] });
  });

  test("the nearest stand is found within range and not beyond it", () => {
    const stand = gateFromIndex("ESSA", "33", AT_RUNWAY)!;
    expect(nearestStandFromIndex("ESSA", { lat: stand.lat, lon: stand.lon }, 60)?.ref).toBe("33");
    expect(nearestStandFromIndex("ESSA", { lat: stand.lat + 0.01, lon: stand.lon }, 60)).toBeNull();
    expect(nearestStandFromIndex("ESPA", { lat: stand.lat, lon: stand.lon }, 60)).toBeNull();
  });

  // gateMinZoom 99 (the zoom tests): every tile is served without a gate
  // point, so only the index can place the plane. Returns the plane as drawn.
  async function openIndexed(page: Page, zoom: number, gateMinZoom: number) {
    const last = Date.now() - HOUR;
    const at = nearGate();
    await open(page, {
      lastReportMs: last,
      history: [position(last, { latitude: at.lat, longitude: at.lon })],
      live: { latitude: at.lat, longitude: at.lon, state: "AT_GATE" },
      status: atGate(last, { lastSeenLat: at.lat, lastSeenLon: at.lon, landing: landingAt("ESSA", last) }),
      view: { ...at, zoom },
      gateMinZoom,
    });
    await expect.poll(async () => (await selectedPlane(page))?.label, { timeout: 10_000 }).toBe("SAS086 · E5B");
    return (await selectedPlane(page))!;
  }

  test("at app zoom 12, with no gate tile, the plane is drawn at its gate and the camera stays put", async ({ page }) => {
    const plane = await openIndexed(page, 12, 99);
    expect(plane.lat).toBeCloseTo(GATE_IDX().lat, 4);
    expect(plane.lon).toBeCloseTo(GATE_IDX().lon, 4);
    // The index answered, so the one-time gate fly-to must not have run: only
    // the selection's own flight (counted before the click) is on the camera.
    await page.waitForTimeout(1_000); // asserting that nothing moves
    expect(await flights(page)).toBe(1);
  });

  test("at app zoom 15, with no gate tile, the plane is drawn at its gate", async ({ page }) => {
    const plane = await openIndexed(page, 15, 99);
    expect(plane.lat).toBeCloseTo(GATE_IDX().lat, 4);
    expect(plane.lon).toBeCloseTo(GATE_IDX().lon, 4);
  });

  test("the index wins over the basemap's own gate point", async ({ page }) => {
    // The mocked tile carries E5B at GATE (59.6485, 17.9215); the index has the
    // real OSM point, elsewhere, so which one the app uses is measurable.
    const plane = await openIndexed(page, 16, 14);
    expect(plane.lat).toBeCloseTo(GATE_IDX().lat, 4);
    expect(plane.lon).toBeCloseTo(GATE_IDX().lon, 4);
    expect(Math.abs(plane.lat - GATE.lat)).toBeGreaterThan(0.001);
  });

  // A remote stand: a parking_position ref, not a gate. ESSA stand 33 is in the
  // generated index, and the provider names it as the gate.
  const STAND = () => gateFromIndex("ESSA", "33", AT_RUNWAY)!;

  async function openOnStand(page: Page, gateRef: string) {
    const stand = STAND();
    const last = Date.now() - HOUR;
    await open(page, {
      lastReportMs: last,
      history: [position(last, { latitude: stand.lat, longitude: stand.lon })],
      live: { latitude: stand.lat, longitude: stand.lon, state: "AT_GATE" },
      status: atGate(last, { gate: gateRef, lastSeenLat: stand.lat, lastSeenLon: stand.lon, landing: landingAt("ESSA", last) }),
      view: { ...stand, zoom: 12 },
      gateMinZoom: 99,
    });
    // The label is the provider's ref, snapped stand or not.
    await expect.poll(async () => (await selectedPlane(page))?.label, { timeout: 10_000 }).toBe(`SAS086 · ${gateRef}`);
    return (await selectedPlane(page))!;
  }

  test("a provider ref that names a remote stand is drawn at that stand", async ({ page }) => {
    const plane = await openOnStand(page, "33");
    expect(plane.lat).toBeCloseTo(STAND().lat, 4);
    expect(plane.lon).toBeCloseTo(STAND().lon, 4);
  });

  test("an unknown ref on the ground snaps to the nearest stand, keeping the provider's label", async ({ page }) => {
    // The provider ref is in neither the index nor a tile, and the view ends up
    // at the airport (the selection's own fly), so the plane is drawn at the
    // nearest stand within STAND_SNAP_M — but still labelled with the ref the
    // provider gave, not the guessed stand's name.
    const plane = await openOnStand(page, "ZZ99");
    expect(plane.label).toBe("SAS086 · ZZ99");
    expect(plane.lat).toBeCloseTo(STAND().lat, 4);
    expect(plane.lon).toBeCloseTo(STAND().lon, 4);
  });
});
