import { expect, type Page, type TestInfo } from "@playwright/test";
import { clusterPositions } from "../../src/map/clusterMath";
import type { LiveMarker } from "../../src/types/flight";
import { SPEED_DEG_PER_S, World, type SimAircraft } from "./world";

/**
 * The scenarios' fake backend, basemap and checks.
 *
 * Backend: every REST endpoint the app calls is served from the World, at
 * the moment of the request, and a WebSocket pushes the current position of
 * every aircraft inside the last reported /live viewport every
 * WS_PUSH_INTERVAL_MS — the same shape and filtering as the real server.
 *
 * Basemap: OpenFreeMap is stubbed with empty vector tiles, so the cyberpunk
 * style renders its land background and graticule — enough to tell a
 * rendered map from a blank or dead canvas, offline and deterministically.
 */

export const WS_PUSH_INTERVAL_MS = 2_000;
// How far a marker may trail the truth: one push interval, the app's 250ms
// batching, and slack for a busy CI runner.
const MAX_LAG_S = (WS_PUSH_INTERVAL_MS + 2_500) / 1000;
export const POSITION_TOLERANCE_DEG = SPEED_DEG_PER_S * MAX_LAG_S;

// cyberpunkMapStyle.ts LAND, the background every rendered frame shows.
const LAND_RGB: [number, number, number] = [0x6b, 0x14, 0x20];

type Bbox = { latMin: number; latMax: number; lonMin: number; lonMax: number };

export interface Harness {
  world: World;
  pageErrors: string[];
  /** Calls to /api/agents/restart (should only ever be page load / Resume). */
  restarts: number;
  step(name: string, fn?: () => Promise<void>): Promise<void>;
}

const mapEval = <T>(page: Page, fn: string): Promise<T> =>
  page.evaluate(`(() => { const map = document.querySelector(".leaflet-container")._leaflet_map; ${fn} })()`);

export async function startHarness(page: Page, testInfo: TestInfo): Promise<Harness> {
  const world = new World();
  const pageErrors: string[] = [];
  let lastBbox: Bbox | null = null;
  let stepNo = 0;
  const h: Harness = {
    world,
    pageErrors,
    restarts: 0,
    async step(name, fn) {
      stepNo++;
      if (fn) await fn();
      await settle(page);
      const file = testInfo.outputPath(`${String(stepNo).padStart(2, "0")}-${name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.png`);
      await page.screenshot({ path: file });
      await testInfo.attach(`step ${stepNo}: ${name}`, { path: file, contentType: "image/png" });
      await checkHealth(page, h, name);
    },
  };

  page.on("pageerror", (e) => pageErrors.push(e.message));

  // ---- basemap ----
  await page.route("https://tiles.openfreemap.org/planet", (r) =>
    r.fulfill({ json: { tilejson: "3.0.0", tiles: ["https://tiles.openfreemap.org/t/{z}/{x}/{y}.pbf"], minzoom: 0, maxzoom: 14, vector_layers: [] } }),
  );
  await page.route(/tiles\.openfreemap\.org\/(t|fonts)\//, (r) => r.fulfill({ body: Buffer.alloc(0), contentType: "application/x-protobuf" }));
  await page.route(/tile\.openstreetmap\.org/, (r) => r.abort());

  // ---- REST ----
  const bboxOf = (u: URL): Bbox | null =>
    u.searchParams.has("latMin")
      ? { latMin: +u.searchParams.get("latMin")!, latMax: +u.searchParams.get("latMax")!, lonMin: +u.searchParams.get("lonMin")!, lonMax: +u.searchParams.get("lonMax")! }
      : null;

  await page.route(/\/api\//, async (route) => {
    const u = new URL(route.request().url());
    const path = u.pathname;
    const now = Date.now();
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });

    if (path === "/api/flights/live/count") return json(world.aircraft.length);
    if (path === "/api/flights/live/clusters") {
      const b = bboxOf(u)!;
      const g = Math.min(25, Math.max(0.5, +(u.searchParams.get("gridDeg") ?? 2)));
      // The server's own bucketing (clusters at the mean position of their aircraft).
      const inView: LiveMarker[] = [];
      for (const a of world.aircraft) {
        if (!world.inBounds(a, b, now)) continue;
        const p = world.positionAt(a, now);
        inView.push({ icao24: a.icao24, callsign: null, observedAt: "", latitude: p.lat, longitude: p.lon, headingDeg: null });
      }
      return json(clusterPositions(inView, g));
    }
    if (path === "/api/flights/live") {
      const b = bboxOf(u);
      if (b) lastBbox = b;
      return json(
        world.aircraft
          .filter((a) => !b || world.inBounds(a, b, now))
          .map((a) => {
            const p = world.flightPosition(a, now);
            return { icao24: p.icao24, callsign: p.callsign, observedAt: p.observedAt, latitude: p.latitude, longitude: p.longitude, headingDeg: p.headingDeg };
          }),
      );
    }
    let m = path.match(/^\/api\/flights\/([0-9a-f]+)\/live$/);
    if (m) {
      const a = world.get(m[1]);
      return a ? json(world.flightPosition(a, now)) : json(null, 404);
    }
    m = path.match(/^\/api\/flights\/([0-9a-f]+)\/history$/);
    if (m) {
      const a = world.get(m[1]);
      return json(a ? world.history(a, now) : []);
    }
    m = path.match(/^\/api\/aircraft\/([0-9a-f]+)$/);
    if (m) {
      const a = world.get(m[1]);
      return a ? json(world.dossier(a, now)) : json(null, 404);
    }
    if (path === "/api/flights/search") {
      const airport = u.searchParams.get("airport")?.trim();
      const q = u.searchParams.get("q")?.trim().toUpperCase();
      let hits: SimAircraft[] = [];
      if (airport) hits = world.searchByAirport(airport);
      else if (q) hits = world.aircraft.filter((a) => a.callsign.startsWith(q));
      hits = [...hits].sort((x, y) => x.callsign.localeCompare(y.callsign)).slice(0, 8);
      return json(hits.map((a) => world.flightPosition(a, now)));
    }
    if (path === "/api/airports/info") {
      const info = world.airportInfo(u.searchParams.get("code") ?? "");
      return info ? json(info) : json(null, 404);
    }
    if (path === "/api/agents/status") return json({ active: true, secondsRemaining: 300 });
    if (path === "/api/agents/restart") {
      h.restarts++;
      return json({ active: true, secondsRemaining: 300 });
    }
    return route.continue();
  });

  // ---- live feed ----
  await page.routeWebSocket(/\/ws\/live/, (ws) => {
    const timer = setInterval(() => {
      if (!lastBbox) return;
      const now = Date.now();
      for (const a of world.aircraft) if (world.inBounds(a, lastBbox, now)) ws.send(JSON.stringify(world.flightPosition(a, now)));
      ws.send(JSON.stringify({ type: "ping" }));
    }, WS_PUSH_INTERVAL_MS);
    ws.onClose(() => clearInterval(timer));
  });

  return h;
}

// ---- map helpers (all user-like where it's practical) ----

export async function map<T>(page: Page, body: string): Promise<T> {
  return mapEval<T>(page, body);
}

/** Lets animations, the 250ms viewport debounce, the request and a render finish. */
export async function settle(page: Page): Promise<void> {
  await page.waitForTimeout(1_200);
}

export async function wheelZoom(page: Page, steps: number, at?: { x: number; y: number }): Promise<void> {
  const box = (await page.locator(".leaflet-container").boundingBox())!;
  await page.mouse.move(at?.x ?? box.x + box.width / 2, at?.y ?? box.y + box.height / 2);
  for (let i = 0; i < Math.abs(steps); i++) {
    await page.mouse.wheel(0, steps > 0 ? -200 : 200); // wheelPxPerZoomLevel is 200
    await page.waitForTimeout(450);
  }
}

export async function drag(page: Page, dx: number, dy: number): Promise<void> {
  const box = (await page.locator(".leaflet-container").boundingBox())!;
  const x = box.x + box.width * 0.6;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(x + (dx * i) / 10, y + (dy * i) / 10);
  await page.mouse.up();
}

/** Jumps the view — the stand-in for "pan a few hundred km", which is fifty drags by hand. */
export async function jumpTo(page: Page, lat: number, lon: number, zoom: number): Promise<void> {
  await mapEval(page, `map.setView([${lat}, ${lon}], ${zoom}); return null;`);
}

export async function zoomLevel(page: Page): Promise<number> {
  return mapEval(page, "return map.getZoom();");
}

export async function centre(page: Page): Promise<{ lat: number; lon: number }> {
  return mapEval(page, "const c = map.getCenter(); return { lat: c.lat, lon: c.lng };");
}

/** Every plane marker on screen: its callsign and where it's drawn. */
export async function planeMarkers(page: Page): Promise<{ callsign: string; lat: number; lon: number; exiting: boolean }[]> {
  return mapEval(
    page,
    `const out = []; const view = map.getBounds();
     map.eachLayer((l) => {
       const el = l.getElement && l.getElement();
       if (!el || !el.classList.contains("plane-icon") || !l.getLatLng) return;
       const ll = l.getLatLng();
       if (!view.contains(ll)) return;
       out.push({ callsign: el.querySelector(".plane-icon-label")?.textContent ?? "", lat: ll.lat, lon: ll.lng, exiting: el.classList.contains("plane-icon--exiting") });
     });
     return out;`,
  );
}

/** Clicks the plane marker labelled `callsign`, like a user would. */
export async function clickPlane(page: Page, callsign: string): Promise<void> {
  await page.locator(".plane-icon:not(.plane-icon--exiting)", { has: page.locator(".plane-icon-label", { hasText: new RegExp(`^${callsign}$`) }) }).click();
}

/** A plane on screen that isn't covered by another one, to click. */
export async function pickVisiblePlane(page: Page, near?: { lat: number; lon: number }): Promise<string> {
  const markers = (await planeMarkers(page)).filter((m) => !m.exiting && m.callsign);
  expect(markers.length, "no plane markers on screen to pick from").toBeGreaterThan(0);
  const sorted = near ? markers.sort((a, b) => Math.hypot(a.lat - near.lat, a.lon - near.lon) - Math.hypot(b.lat - near.lat, b.lon - near.lon)) : markers;
  for (const m of sorted) {
    const loc = page.locator(".plane-icon:not(.plane-icon--exiting)", { has: page.locator(".plane-icon-label", { hasText: new RegExp(`^${m.callsign}$`) }) });
    const box = await loc.boundingBox();
    if (!box) continue;
    // The topmost element at its centre must be this marker (not a neighbour or a panel).
    const hit = await page.evaluate(
      ({ x, y, cs }) => {
        const el = document.elementFromPoint(x, y)?.closest(".plane-icon");
        return el?.querySelector(".plane-icon-label")?.textContent === cs;
      },
      { x: box.x + box.width / 2, y: box.y + box.height / 2, cs: m.callsign },
    );
    if (hit) return m.callsign;
  }
  throw new Error("every plane marker on screen is covered by something else");
}

// ---- health ----

async function landFraction(page: Page): Promise<number> {
  const box = (await page.locator(".leaflet-container").boundingBox())!;
  const png = await page.screenshot({ clip: { x: box.x + box.width * 0.55, y: box.y + box.height * 0.15, width: box.width * 0.3, height: box.height * 0.7 } });
  return page.evaluate(
    async ({ b64, rgb }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.width;
      c.height = img.height;
      const ctx = c.getContext("2d")!;
      ctx.drawImage(img, 0, 0);
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      let hit = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (Math.abs(d[i] - rgb[0]) < 40 && Math.abs(d[i + 1] - rgb[1]) < 40 && Math.abs(d[i + 2] - rgb[2]) < 40) hit++;
      }
      return hit / (d.length / 4);
    },
    { b64: png.toString("base64"), rgb: LAND_RGB },
  );
}

/**
 * After every step:
 *  - the basemap is actually drawn (cyberpunk land colour fills most of a
 *    sampled region, not a blank or black canvas);
 *  - every plane marker on screen is where that aircraft really is, give or
 *    take one live-update cycle;
 *  - no uncaught page errors.
 */
export async function checkHealth(page: Page, h: Harness, step: string): Promise<void> {
  const theme = await page.evaluate(() => document.documentElement.dataset.theme ?? "default");
  if (theme === "cyberpunk") {
    const frac = await landFraction(page);
    expect(frac, `[${step}] basemap not rendered: only ${(frac * 100).toFixed(0)}% of the sampled area is land colour`).toBeGreaterThan(0.35);
    // A dead MapLibre worker still paints the background colour (it shipped
    // to production once looking exactly like that), so also require every
    // tile in view to have finished processing.
    await expect
      .poll(() => mapEval<string>(page, `
          let gl = null;
          map.eachLayer((l) => { if (l.getMaplibreMap) gl = l.getMaplibreMap(); });
          if (!gl) return "no MapLibre layer";
          if (!gl.isStyleLoaded()) return "style not loaded";
          return gl.areTilesLoaded() ? "ok" : "tiles still loading";`), { message: `[${step}] basemap tiles`, timeout: 5_000 })
      .toBe("ok");
  }

  const now = Date.now();
  const wrong: string[] = [];
  for (const m of await planeMarkers(page)) {
    if (m.exiting) continue;
    const a = h.world.byCallsign(m.callsign);
    if (!a) {
      wrong.push(`${m.callsign}: not an aircraft in the world`);
      continue;
    }
    const truth = h.world.positionAt(a, now);
    const off = Math.hypot(m.lat - truth.lat, m.lon - truth.lon);
    if (off > POSITION_TOLERANCE_DEG) wrong.push(`${m.callsign} drawn ${off.toFixed(4)}° from its true position (${(off / SPEED_DEG_PER_S).toFixed(0)}s stale)`);
  }
  expect(wrong, `[${step}] plane markers not at their true positions`).toEqual([]);
  expect(h.pageErrors, `[${step}] page errors`).toEqual([]);
}

/** The selected aircraft: panel open for it, and the map centred on its true position. */
export async function expectCentredOn(page: Page, h: Harness, callsign: string, step: string): Promise<void> {
  const a = h.world.byCallsign(callsign)!;
  await expect(page.locator(".details-panel-meta")).toContainText(`ICAO24 ${a.icao24.toUpperCase()}`);
  const truth = h.world.positionAt(a);
  const c = await centre(page);
  const off = Math.hypot(c.lat - truth.lat, c.lon - truth.lon);
  expect(off, `[${step}] map centred ${off.toFixed(4)}° (${(off / SPEED_DEG_PER_S).toFixed(0)}s of flight) from ${callsign}'s true position`).toBeLessThan(POSITION_TOLERANCE_DEG);
}
