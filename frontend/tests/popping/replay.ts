/**
 * The popping harness: record once, replay deterministically, measure what the
 * map actually drew.
 *
 * It serves the fixture set recorded by scripts/record-popping-fixtures.ts
 * (tests/fixtures/popping/recording.json) to the app in order — one recorded
 * tick every tickMs, oldest first, with the page clock pinned to the
 * recording's epoch so the replayed timeline lines up with the app's own
 * `Date.now()` and nothing depends on the wall clock. The REST endpoints the
 * app calls are answered from the current tick (the same shapes the backend
 * sends: markers for /live and the WebSocket, one-plane-per-cell for
 * /overview, full positions for /{icao}/live, TrackStatus for /{icao}/status),
 * and each tick's WebSocket frames are the recorded positions for the
 * viewport the app last reported — one LiveFrame per aircraft, exactly what
 * LiveFeedBroadcaster pushes.
 *
 * After a gesture the test takes a `step()`: it reads what was drawn with
 * renderedPlanes() and compares it with the recorded truth at that tick. The
 * per-step numbers are the popping signals:
 *
 *   - vanished / appeared: a plane that left or joined the drawn set while the
 *     view was still, and whose recorded position was inside the drawn area
 *     both times — it should have stayed drawn. This is the pop by eye.
 *   - backwards: a plane drawn at both steps whose drawn position moved
 *     backwards along its own track (see #53, a stale cached position).
 *   - selectedOffTrail: the selected plane's marker away from the end of its
 *     drawn trail.
 *
 * See docs/popping-harness.md.
 */
import { expect, type Page, type TestInfo } from "@playwright/test";
import { clusterMockFleet, onePerCell } from "../../src/api/mockFleet";
import recording from "../fixtures/popping/recording.json" with { type: "json" };

// ---- the recording's shape (mirrors scripts/record-popping-fixtures.ts) ----

interface RecFleet {
  icao24: string;
  callsign: string;
  altitudeM: number;
  velocityMs: number;
  headingDeg: number;
  agentSource: string;
  onGround: boolean;
}
interface RecTick {
  lat: number[];
  lon: number[];
}
interface RecStatus {
  icao24: string;
  state: string;
  confidence: number | null;
  source: string;
  sourceKind: string;
  lastSeenAt: string;
  lastSeenLat: number;
  lastSeenLon: number;
  estimate: null;
  landing: null;
  gate: null;
  terminal: null;
  confirmedAt: null;
}
interface Recording {
  meta: {
    version: number;
    source: string;
    recordedAt: string;
    recordedAtMs: number;
    tickMs: number;
    tickCount: number;
    bbox: { latMin: number; latMax: number; lonMin: number; lonMax: number };
    zooms: number[];
    wsNote: string;
  };
  fleet: RecFleet[];
  ticks: RecTick[];
  selected: { candidates: string[]; history: Record<string, { t: number; lat: number; lon: number }[]>; status: Record<string, RecStatus[]> };
}

const REC = recording as Recording;

/** The recorded tick's own instant: the recording's epoch plus i * tickMs. */
export const tickTime = (i: number): number => REC.meta.recordedAtMs + i * REC.meta.tickMs;

export const CENTRE = { lat: 59.33, lon: 18.06 };
export const ZOOMS = REC.meta.zooms;

// ---- config (the popping budget) ----

/**
 * How many popping events a scenario may rack up before the test fails.
 * Set to the baseline measured on main (see #86) with a little headroom, so
 * the test is a durable guard rail rather than a red build: the point is that
 * #66/#53's fixes drive these numbers *down*, and a regression pushes them
 * back up. Tighten the budget as the numbers fall. The baseline measured on
 * main (one worker, sandbox): vanished 4/1/0/1, appeared 1/2/1/1, backwards 0
 * in every scenario, and the selected plane about 0.0045 deg — one 2 s tick of
 * flight — behind its trail end on the still steps after selecting, which is
 * why selectedOffTrail is not 0.
 */
export const BUDGET = {
  vanished: 8,
  appeared: 8,
  backwards: 2,
  selectedOffTrail: 6,
};

/** A plane is "off its track" when its drawn position moved backwards by more than this (deg) since the last step. */
export const BACKWARDS_TOL_DEG = 0.0005;
/** The selected plane counts as off its trail beyond this (deg). */
export const TRAIL_TOL_DEG = 0.002;
/** The view counts as still when the centre moved less than this (deg) and the zoom did not change. */
export const STILL_DEG = 0.02;
const STILL_ZOOM = 0.05;

const RENDER_MARGIN = 0.4; // main.ts RENDER_MARGIN: what the app draws beyond each edge.

// ---- shapes ----

export interface DrawnPlane {
  icao24: string;
  callsign: string;
  lat: number;
  lon: number;
  x: number;
  y: number;
  selected: boolean;
}
export interface TruthPlane {
  icao24: string;
  callsign: string;
  lat: number;
  lon: number;
  x: number;
  y: number;
  headingDeg: number;
  inDrawnArea: boolean;
}
export interface StepMetrics {
  name: string;
  zoom: number;
  centre: { lat: number; lon: number };
  viewStill: boolean;
  drawn: number;
  vanished: string[];
  appeared: string[];
  backwards: { icao24: string; backDeg: number }[];
  selectedOffTrail: { icao24: string; offDeg: number } | null;
  /** The drawn set at this step, kept so the next step can diff against it. */
  truthDrawn: DrawnPlane[];
}

export interface Replay {
  /** The recorded tick now being served. */
  tickIndex: number;
  /** Advances one recorded tick, pushes its WebSocket frames, waits for the app to settle. */
  tick(): Promise<void>;
  /** Reads what was drawn now and returns the popping numbers for this step. */
  step(name: string): Promise<StepMetrics>;
  /** Every step taken, in order. */
  steps: StepMetrics[];
  /** A short, fixed-width table of every step so far. */
  table(): string;
  pageErrors: string[];
  /** The truth for the current tick, projected to page pixels. */
  truth(): Promise<TruthPlane[]>;
  drawn(): Promise<DrawnPlane[]>;
  summary(): string;
}

type Bbox = { latMin: number; latMax: number; lonMin: number; lonMax: number };

const mapEval = <T>(page: Page, fn: string): Promise<T> =>
  page.evaluate(`(() => { const map = document.querySelector(".map-container")._flightMap; ${fn} })()`);

/** Lets a gesture's animation, the 250ms viewport debounce, the request and a render finish. */
export async function settle(page: Page): Promise<void> {
  await page.waitForTimeout(1_000);
}

/**
 * Waits (best-effort) until the app has applied the current tick: most of what
 * it drew sits at the recorded position for this tick. Without it a step could
 * be read just before a tick's push or a viewport response landed, and the
 * same run would count a different set of planes — the timing race is real,
 * but it must not decide what the numbers are.
 */
async function waitApplied(
  page: Page,
  projection: () => Promise<{ pts: TruthPlane[] }>,
  drawn: () => Promise<DrawnPlane[]>,
): Promise<void> {
  try {
    await expect
      .poll(
        async () => {
          const d = await drawn();
          if (d.length === 0) return 1;
          const byId = new Map((await projection()).pts.map((p) => [p.icao24, p]));
          let ok = 0;
          for (const p of d) {
            const t = byId.get(p.icao24);
            if (t && Math.hypot(p.lat - t.lat, p.lon - t.lon) < 0.0008) ok++;
          }
          return ok / d.length;
        },
        { timeout: 15_000, intervals: [200], message: "the app applied the current tick" },
      )
      .toBeGreaterThan(0.75);
  } catch {
    // Never a failure by itself: the step is what gets measured, whatever it
    // caught. A run where this keeps timing out is itself worth looking at.
  }
}

export async function startReplay(page: Page, testInfo: TestInfo): Promise<Replay> {
  const pageErrors: string[] = [];
  let lastBbox: Bbox | null = null;
  let tickIndex = 0;
  const steps: StepMetrics[] = [];

  page.on("pageerror", (e) => pageErrors.push(e.message));

  // The clock is pinned to the recording's epoch: the app's own time lines up
  // with the replayed timeline (LiveMarkers' observedAt, the 2h dimming rule),
  // and the run never depends on when it happens to be executed.
  await page.clock.install({ time: REC.meta.recordedAtMs });

  // ---- basemap ----
  await page.route("https://tiles.openfreemap.org/planet", (r) =>
    r.fulfill({ json: { tilejson: "3.0.0", tiles: ["https://tiles.openfreemap.org/t/{z}/{x}/{y}.pbf"], minzoom: 0, maxzoom: 14, vector_layers: [] } }),
  );
  await page.route(/tiles\.openfreemap\.org\/(t|fonts)\//, (r) => r.fulfill({ body: "", contentType: "application/x-protobuf" }));
  await page.route(/tile\.openstreetmap\.org/, (r) => r.abort());

  // ---- the recorded tick, served as the backend ----
  const at = () => REC.ticks[Math.min(tickIndex, REC.ticks.length - 1)];
  const now = () => tickTime(Math.min(tickIndex, REC.ticks.length - 1));
  const markerAt = (f: RecFleet, i: number) => ({
    icao24: f.icao24,
    callsign: f.callsign,
    observedAt: new Date(now()).toISOString(),
    latitude: REC.ticks[i].lat[REC.fleet.indexOf(f)],
    longitude: REC.ticks[i].lon[REC.fleet.indexOf(f)],
    headingDeg: f.headingDeg,
    onGround: f.onGround,
  });
  const inBbox = (lat: number, lon: number, b: Bbox): boolean => lat >= b.latMin && lat <= b.latMax && lon >= b.lonMin && lon <= b.lonMax;
  const markersIn = (b: Bbox | null): { icao24: string; callsign: string; observedAt: string; latitude: number; longitude: number; headingDeg: number | null; onGround: boolean }[] => {
    const t = at();
    return REC.fleet
      .map((f, i) => ({ f, i }))
      .filter(({ i }) => !b || inBbox(t.lat[i], t.lon[i], b))
      .map(({ f, i }) => ({ icao24: f.icao24, callsign: f.callsign, observedAt: new Date(now()).toISOString(), latitude: t.lat[i], longitude: t.lon[i], headingDeg: f.headingDeg, onGround: f.onGround }));
  };
  const bboxOf = (u: URL): Bbox | null =>
    u.searchParams.has("latMin")
      ? { latMin: +u.searchParams.get("latMin")!, latMax: +u.searchParams.get("latMax")!, lonMin: +u.searchParams.get("lonMin")!, lonMax: +u.searchParams.get("lonMax")! }
      : null;

  await page.route(/\/api\//, async (route) => {
    const u = new URL(route.request().url());
    const path = u.pathname;
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });

    if (path === "/api/geo") return route.fulfill({ status: 204 });
    if (path === "/api/flights/live/count") return json(REC.fleet.length);
    if (path === "/api/flights/live/clusters" || path === "/api/flights/live/overview") {
      const b = bboxOf(u)!;
      const g = Math.min(40, Math.max(0.5, +(u.searchParams.get("gridDeg") ?? 2)));
      const inView = markersIn(b);
      if (path.endsWith("/overview")) return json({ planes: onePerCell(inView, g), clusters: [] });
      return json(clusterMockFleet(inView, g));
    }
    if (path === "/api/flights/live") {
      const b = bboxOf(u);
      if (b) lastBbox = b;
      return json(markersIn(b));
    }
    let m = path.match(/^\/api\/flights\/([0-9a-f]+)\/live$/);
    if (m) {
      const i = REC.fleet.findIndex((f) => f.icao24 === m![1]);
      if (i < 0) return json(null, 404);
      const f = REC.fleet[i];
      return json({ id: 0, ...markerAt(f, Math.min(tickIndex, REC.ticks.length - 1)), altitudeM: f.altitudeM, velocityMs: f.velocityMs, verticalRateMs: 0, agentSource: f.agentSource });
    }
    m = path.match(/^\/api\/flights\/([0-9a-f]+)\/status$/);
    if (m) {
      const frames = (REC.selected.status[m[1]] ?? []).filter((s) => Date.parse(s.lastSeenAt) <= now());
      return frames.length ? json(frames[frames.length - 1]) : json(null, 404);
    }
    m = path.match(/^\/api\/flights\/([0-9a-f]+)\/history$/);
    if (m) {
      const from = Date.parse(u.searchParams.get("from") ?? "") || 0;
      const to = Date.parse(u.searchParams.get("to") ?? "") || Infinity;
      const pts = (REC.selected.history[m[1]] ?? []).filter((p) => p.t >= from && p.t <= to);
      return json(pts.map((p, i) => ({ id: i, icao24: m![1], callsign: REC.fleet.find((f) => f.icao24 === m![1])?.callsign ?? null, observedAt: new Date(p.t).toISOString(), latitude: p.lat, longitude: p.lon, altitudeM: null, velocityMs: null, headingDeg: null, verticalRateMs: null, onGround: false, agentSource: "opensky" })));
    }
    m = path.match(/^\/api\/aircraft\/([0-9a-f]+)$/);
    if (m) {
      const f = REC.fleet.find((x) => x.icao24 === m![1]);
      return f ? json({ icao24: f.icao24, registration: null, model: "Airbus A320neo", operator: f.callsign.slice(0, 3), originAirport: null, originAirportName: null, originAirportIata: null, destinationAirport: null, destinationAirportName: null, destinationAirportIata: null, flightMinutes: null, etaMinutes: null, cruisingAltitudeM: f.altitudeM, flightPhase: "CRUISE", staleExplanation: null, legStartAt: new Date(REC.meta.recordedAtMs).toISOString() }) : json(null, 404);
    }
    if (path === "/api/flights/search") return json([]);
    if (path === "/api/airports/info") return json(null, 404);
    if (path === "/api/agents/status") return json({ active: true, secondsRemaining: 300 });
    if (path === "/api/agents/restart") return json({ active: true, secondsRemaining: 300 });
    return route.continue();
  });

  // ---- the WebSocket: each tick pushes that tick's frames for the viewport the app last reported ----
  let socket: { send: (s: string) => void } | null = null;
  await page.routeWebSocket(/\/ws\/live/, (ws) => {
    socket = ws;
    ws.onClose(() => { if (socket === ws) socket = null; });
  });
  function pushTick(): void {
    if (!socket) return;
    for (const m of markersIn(lastBbox)) socket.send(JSON.stringify(m));
    socket.send(JSON.stringify({ type: "ping" }));
  }

  // ---- map helpers ----
  const projection = async (): Promise<{ rect: { x: number; y: number; width: number; height: number }; pts: TruthPlane[] }> =>
    mapEval(
      page,
      `const rect = map.getContainer().getBoundingClientRect();
       const t = ${JSON.stringify(at())};
       const fleet = ${JSON.stringify(REC.fleet)};
       const margin = ${RENDER_MARGIN};
       const minX = -rect.width * margin, maxX = rect.width * (1 + margin);
       const minY = -rect.height * margin, maxY = rect.height * (1 + margin);
       const pts = fleet.map((f, i) => { const pt = map.project(t.lat[i], t.lon[i]); return { icao24: f.icao24, callsign: f.callsign, lat: t.lat[i], lon: t.lon[i], x: pt.x + rect.x, y: pt.y + rect.y, headingDeg: f.headingDeg, inDrawnArea: pt.x >= minX && pt.x <= maxX && pt.y >= minY && pt.y <= maxY }; });
       return { rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, pts };`,
    );

  const drawn = async (): Promise<DrawnPlane[]> =>
    mapEval(
      page,
      `const rect = map.getContainer().getBoundingClientRect();
       return map.renderedPlanes().map((p) => ({ icao24: p.icao24, callsign: p.callsign, lat: p.lat, lon: p.lon, x: p.x + rect.x, y: p.y + rect.y, selected: p.selected }));`,
    );

  const routeEnd = async (): Promise<{ lat: number; lon: number } | null> =>
    page.evaluate<{ lat: number; lon: number } | null>(`(async () => {
      const map = document.querySelector(".map-container")._flightMap;
      const src = map.gl.getSource("flight-route");
      if (!src) return null;
      const data = await src.getData();
      const c = data.geometry && data.geometry.coordinates;
      if (!c || c.length === 0) return null;
      const last = c[c.length - 1];
      return { lat: last[1], lon: last[0] };
    })()`);

  const view = async (): Promise<{ zoom: number; centre: { lat: number; lon: number } }> =>
    mapEval(page, `const c = map.getCenter(); return { zoom: map.getZoom(), centre: { lat: c.lat, lon: c.lon } };`);

  const h: Replay = {
    get tickIndex() { return tickIndex; },
    steps,
    pageErrors,
    truth: async () => (await projection()).pts,
    drawn,
    async tick() {
      await settle(page);
      tickIndex++;
      pushTick();
      await settle(page);
      await waitApplied(page, projection, drawn);
    },
    async step(name) {
      await waitApplied(page, projection, drawn);
      const truth = (await projection()).pts;
      const d = await drawn();
      const v = await view();
      const prev = steps[steps.length - 1] ?? null;
      const drawnIds = new Set(d.map((p) => p.icao24));
      const truthById = new Map(truth.map((t) => [t.icao24, t]));
      const viewStill = !!prev && Math.abs(v.zoom - prev.zoom) < STILL_ZOOM && Math.hypot(v.centre.lat - prev.centre.lat, v.centre.lon - prev.centre.lon) < STILL_DEG;

      const vanished: string[] = [];
      const appeared: string[] = [];
      const backwards: { icao24: string; backDeg: number }[] = [];

      if (prev) {
        const prevDrawn = new Map(prev.truthDrawn.map((p) => [p.icao24, p]));
        for (const p of prev.truthDrawn) {
          const t = truthById.get(p.icao24);
          if (viewStill && !drawnIds.has(p.icao24) && t && t.inDrawnArea) vanished.push(p.icao24);
        }
        for (const p of d) {
          if (viewStill && !prevDrawn.has(p.icao24) && (truthById.get(p.icao24)?.inDrawnArea ?? false)) appeared.push(p.icao24);
        }
        for (const p of d) {
          const before = prevDrawn.get(p.icao24);
          const t = truthById.get(p.icao24);
          if (!before || !t) continue;
          const dx = p.lon - before.lon;
          const dy = p.lat - before.lat;
          const hx = Math.sin((t.headingDeg * Math.PI) / 180);
          const hy = Math.cos((t.headingDeg * Math.PI) / 180);
          const along = dx * hx + dy * hy;
          if (along < -BACKWARDS_TOL_DEG) backwards.push({ icao24: p.icao24, backDeg: -along });
        }
      }

      const selected = d.find((p) => p.selected) ?? null;
      const end = selected ? await routeEnd() : null;
      const selectedOffTrail =
        selected && end && Math.hypot(selected.lat - end.lat, selected.lon - end.lon) > TRAIL_TOL_DEG
          ? { icao24: selected.icao24, offDeg: Math.hypot(selected.lat - end.lat, selected.lon - end.lon) }
          : null;

      const metrics: StepMetrics = {
        name,
        zoom: v.zoom,
        centre: v.centre,
        viewStill: !!prev && viewStill,
        drawn: d.length,
        vanished,
        appeared,
        backwards,
        selectedOffTrail,
        truthDrawn: d,
      };
      steps.push(metrics);

      // The table and these per-step numbers are the evidence. A screenshot
      // per step was tried and cost more than the whole gesture under four-way
      // software WebGL, so only the numbers are attached.
      await testInfo.attach(`step ${steps.length}: ${name}`, { body: JSON.stringify({ ...metrics, truthDrawn: undefined, view: v }), contentType: "application/json" });
      return metrics;
    },
    table() {
      const rows = steps.map((s, i) => [
        String(i + 1).padStart(2),
        s.name.slice(0, 34).padEnd(34),
        s.zoom.toFixed(1).padStart(4),
        (s.viewStill ? "still" : "moved").padEnd(5),
        String(s.drawn).padStart(5),
        String(s.vanished.length).padStart(8),
        String(s.appeared.length).padStart(8),
        String(s.backwards.length).padStart(9),
        String(s.backwards.reduce((a, b) => Math.max(a, b.backDeg), 0)).padStart(9),
        (s.selectedOffTrail ? s.selectedOffTrail.offDeg.toFixed(4) : "-").padStart(11),
      ]);
      const head = ["#", "step".padEnd(34), "zoom", "view".padEnd(5), "drawn", "vanished", "appeared", "backwards", "back max°", "sel off°"];
      return [head, ...rows].map((r) => r.join("  ")).join("\n");
    },
    summary() {
      const sum = (f: (s: StepMetrics) => number) => steps.reduce((a, s) => a + f(s), 0);
      return (
        `steps ${steps.length}  drawn ${steps.map((s) => s.drawn).join("/")}  ` +
        `vanished ${sum((s) => s.vanished.length)}  appeared ${sum((s) => s.appeared.length)}  ` +
        `backwards ${sum((s) => s.backwards.length)}  selectedOffTrail ${sum((s) => (s.selectedOffTrail ? 1 : 0))}`
      );
    },
  };
  return h;
}

/** Boots the app and waits until it has drawn planes. */
export async function boot(page: Page): Promise<void> {
  await page.goto("/");
  // The app marks the map container ready after its opening view and first
  // viewport report; then the boot screen (data + basemap in) removes itself.
  // Generous: four browsers sharing four software-WebGL vCPUs is slow, and a
  // boot that lands late must not fail a scenario about popping.
  await expect(page.locator('.map-container[data-ready="true"]')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator(".boot-screen")).toHaveCount(0, { timeout: 60_000 });
  await expect.poll(async () => (await mapEval<number>(page, "return map.renderedPlanes().length;")), { timeout: 40_000, intervals: [500], message: "planes drawn" }).toBeGreaterThan(0);
}

// ---- gestures ----

/** Drags the map by (dx, dy) page pixels, like a finger on a trackpad. */
export async function drag(page: Page, dx: number, dy: number): Promise<void> {
  const box = (await page.locator(".map-container").boundingBox())!;
  const x = box.x + box.width * 0.6;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(x + (dx * i) / 10, y + (dy * i) / 10);
  await page.mouse.up();
}

/** Zooms `levels` whole levels with the mouse wheel (two notches a level, see WHEEL_ZOOM_RATE in map/map.ts). */
export async function wheelZoom(page: Page, levels: number): Promise<void> {
  const box = (await page.locator(".map-container").boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < Math.abs(levels) * 2; i++) {
    await page.mouse.wheel(0, levels > 0 ? -100 : 100);
    await page.waitForTimeout(400);
  }
}

/** Jumps the view: a stand-in for "pan a few hundred km", which is fifty drags by hand. */
export async function jumpTo(page: Page, lat: number, lon: number, zoom: number): Promise<void> {
  await mapEval(page, `map.setView([${lat}, ${lon}], ${zoom}); return null;`);
}

/** A two-finger pinch out (zoom in, `scaleFactor` > 1) or in (< 1), like a phone. */
export async function pinch(page: Page, scaleFactor: number): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  const box = (await page.locator(".map-container").boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const start = 60;
  const end = start * scaleFactor;
  const points = (gap: number) => [
    { x: cx - gap, y: cy },
    { x: cx + gap, y: cy },
  ];
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: points(start) });
  for (let i = 1; i <= 8; i++) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: points(start + ((end - start) * i) / 8) });
    await page.waitForTimeout(60);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

/** Clicks the plane labelled `callsign`, like a user would. */
export async function clickPlane(page: Page, callsign: string): Promise<void> {
  const m = (await mapEval<DrawnPlane[]>(page, 'const rect = map.getContainer().getBoundingClientRect(); return map.renderedPlanes().filter((p) => map.contains(p.lat, p.lon)).map((p) => ({ icao24: p.icao24, callsign: p.callsign, lat: p.lat, lon: p.lon, x: p.x + rect.x, y: p.y + rect.y, selected: p.selected }));')).find((p) => p.callsign === callsign);
  expect(m, `${callsign} is not drawn`).toBeTruthy();
  await page.mouse.click(m!.x, m!.y);
}

/** A recorded candidate plane on screen that is not covered by another one. */
export async function pickCandidate(page: Page): Promise<string> {
  const list = await mapEval<DrawnPlane[]>(page, 'const rect = map.getContainer().getBoundingClientRect(); return map.renderedPlanes().filter((p) => map.contains(p.lat, p.lon)).map((p) => ({ icao24: p.icao24, callsign: p.callsign, lat: p.lat, lon: p.lon, x: p.x + rect.x, y: p.y + rect.y, selected: p.selected }));');
  const candidates = REC.selected.candidates;
  const on = list.filter((p) => candidates.includes(p.icao24));
  expect(on.length, "a recorded candidate plane is on screen").toBeGreaterThan(0);
  for (const p of on.sort((a, b) => a.icao24.localeCompare(b.icao24))) {
    const hit = await mapEval<boolean>(
      page,
      `const rect = map.getContainer().getBoundingClientRect();
       if (document.elementFromPoint(${p.x}, ${p.y}) !== map.gl.getCanvas()) return false;
       return map.hitAt({ x: ${p.x} - rect.x, y: ${p.y} - rect.y })?.id === "plane:${p.icao24}";`,
    );
    if (hit) return p.callsign;
  }
  throw new Error("no recorded candidate plane is clickable on screen");
}

export const candidateIcao24s = REC.selected.candidates;
export { REC };
