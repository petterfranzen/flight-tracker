import { expect, type Locator, type Page, type Route } from "@playwright/test";
import type { FlightMap, RenderedAirport, RenderedPlane } from "../src/map/map";
import liveFixture from "./fixtures/live.json" with { type: "json" };
import history4aad15 from "./fixtures/history-4aad15.json" with { type: "json" };
import history4d00d9 from "./fixtures/history-4d00d9.json" with { type: "json" };

export const LIVE_FIXTURE = liveFixture as FlightPositionFixture[];

export const HISTORIES: Record<string, FlightPositionFixture[]> = {
  "4aad15": history4aad15 as FlightPositionFixture[],
  "4d00d9": history4d00d9 as FlightPositionFixture[],
};

export interface FlightPositionFixture {
  id: number;
  icao24: string;
  callsign: string | null;
  observedAt: string;
  latitude: number;
  longitude: number;
  altitudeM: number | null;
  velocityMs: number | null;
  headingDeg: number | null;
  verticalRateMs: number | null;
  onGround: boolean;
  agentSource: string;
}

/** One aggregated grid cell, matching backend ClusterPoint — see clustering.spec.ts. */
export interface ClusterPointFixture {
  lat: number;
  lon: number;
  count: number;
}

/**
 * Intercepts every network call FlightMap makes and serves fixture data
 * captured once from the real API (see tests/fixtures/) — no docker-compose
 * stack, no live backend, fully deterministic. `historyDelayMs` lets a
 * specific aircraft's /history response be held up artificially, which is
 * how the selection-race regression test (marker-position.spec.ts)
 * reproduces "select A, then B before A's history resolves" on demand.
 * `clusters` lets a test supply real cluster data instead of the default
 * empty response — see clustering.spec.ts, which needs a populated cell to
 * assert against.
 */
export async function mockFlightApi(
  page: Page,
  opts?: { historyDelayMs?: Record<string, number>; clusters?: ClusterPointFixture[]; overviewPlanes?: unknown[]; geo?: { lat: number; lon: number } | null; activeCount?: number; seenCount?: number; realTiles?: boolean },
) {
  // Basemap: an empty tileset (style and fonts load, every tile is blank), so
  // the MapLibre basemap draws only its background: fast and identical on
  // every run, with no real tile server involved. `realTiles` leaves the
  // network alone for tests that are about the basemap itself (and a test's
  // own later page.route for these URLs still wins).
  if (!opts?.realTiles) await stubBasemapTiles(page);
  await page.route("**/api/flights/live/clusters*", (route: Route) => route.fulfill({ json: opts?.clusters ?? [] }));
  // The worldwide active-aircraft count behind the cyberpunk chip.
  await page.route("**/api/flights/live/count*", (route: Route) =>
    route.fulfill({ json: route.request().url().includes("active=true") ? (opts?.activeCount ?? 0) : (opts?.seenCount ?? 0) }),
  );
  // The visitor's approximate location: none (204) unless a test supplies one.
  await page.route("**/api/geo", (route: Route) => (opts?.geo ? route.fulfill({ json: { ...opts.geo, precision: "city" } }) : route.fulfill({ status: 204 })));
  // The zoomed-out fetch: top active aircraft (none by default) plus the same clusters.
  await page.route("**/api/flights/live/overview*", (route: Route) =>
    route.fulfill({ json: { planes: opts?.overviewPlanes ?? [], clusters: opts?.clusters ?? [] } }),
  );
  await page.route("**/api/flights/live*", (route: Route) => route.fulfill({ json: LIVE_FIXTURE }));

  // FlightMap's dedicated priority poll for the selected aircraft (see
  // fetchFlightLive/FlightController.liveOne) — distinct from the plain
  // "**/api/flights/live*" mock above, which never matches this (an
  // icao24 path segment sits between "flights/" and "live" here).
  await page.route("**/api/flights/*/live*", (route: Route) => {
    const url = new URL(route.request().url());
    const icao24 = url.pathname.split("/")[3];
    const match = LIVE_FIXTURE.find((p) => p.icao24 === icao24);
    return match ? route.fulfill({ json: match }) : route.fulfill({ status: 404, json: null });
  });

  await page.route("**/api/flights/*/history*", async (route: Route) => {
    const url = new URL(route.request().url());
    const icao24 = url.pathname.split("/")[3];
    const delay = opts?.historyDelayMs?.[icao24] ?? 0;
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    await route.fulfill({ json: HISTORIES[icao24] ?? [] });
  });

  // FlightSearch's two modes (see FlightController.search): `q` filters
  // LIVE_FIXTURE by callsign prefix, same rule the server applies; `airport`
  // can't be matched against this fixture (it carries no route/airport
  // data) so any non-empty value just returns a single fixed hit — enough
  // to exercise "type, get a result, select it" without needing that data.
  await page.route("**/api/flights/search*", (route: Route) => {
    const url = new URL(route.request().url());
    const q = url.searchParams.get("q")?.trim();
    const airport = url.searchParams.get("airport")?.trim();
    if (airport) {
      return route.fulfill({ json: LIVE_FIXTURE.filter((p) => p.icao24 === "4aad15") });
    }
    if (q) {
      return route.fulfill({ json: LIVE_FIXTURE.filter((p) => p.callsign?.startsWith(q)) });
    }
    return route.fulfill({ json: [] });
  });

  await page.route("**/api/aircraft/*", (route: Route) => route.fulfill({ status: 404, json: null }));
  await page.route("**/api/agents/status", (route: Route) => route.fulfill({ json: { active: false, secondsRemaining: 0 } }));
  // The window is closed (above), so page load reopens it. Unmocked, this went
  // to the dev server's proxy and logged a connection error on every test.
  await page.route("**/api/agents/restart", (route: Route) => route.fulfill({ json: { active: true, secondsRemaining: 300 } }));

  // Accept the WebSocket connection so subscribeLiveFeed doesn't error, but
  // never send anything — these tests exercise the REST paths (initial
  // /live paint, /history on selection, the reconcile fetch), not the live
  // push feed.
  await page.routeWebSocket("**/ws/live", () => {});
}

// Finds the map adapter, in-page: map/map.ts's createMap stashes it on its
// own container element the moment it's created (`container._flightMap`),
// scoped to `.map-container` so it can never accidentally match an
// unrelated element. Injected as a string (see withMap below) so it runs
// inside the page, not this Node process.
const FIND_MAP_SNIPPET = `
  function __findFlightMap() {
    const el = document.querySelector(".map-container");
    const map = el && el._flightMap;
    if (!map) throw new Error("map not found (.map-container has no _flightMap)");
    return map;
  }
`;

/**
 * Runs `fn(map, ...args)` inside the page against the live map adapter
 * (FlightMap: app zoom units, [lat, lon] positions, container pixels).
 * `fn` is serialized via toString() and reconstructed in-page — it must be
 * self-contained (only reference `map` and `args`, never variables closed
 * over from the Node-side test file, which don't survive that
 * serialization) and `args` must be JSON-serializable.
 */
export async function withMap<T, A extends unknown[]>(page: Page, fn: (map: FlightMap, ...args: A) => T, ...args: A): Promise<Awaited<T>> {
  return page.evaluate(
    ({ snippet, fnStr, args }) => {
      // eslint-disable-next-line no-eval
      const findMap = eval(`(function() { ${snippet}; return __findFlightMap(); })`);
      const map = findMap();
      // eslint-disable-next-line no-eval
      const action = eval(`(${fnStr})`);
      return action(map, ...args);
    },
    { snippet: FIND_MAP_SNIPPET, fnStr: fn.toString(), args },
  ) as Promise<Awaited<T>>;
}

/**
 * The expected on-*page* pixel position for a lat/lon, matching what
 * Playwright's boundingBox() returns for elements (viewport-relative).
 * map.project() alone isn't that — it's relative to the map container's
 * own top-left, which can sit below other chrome, so comparing it directly
 * against a marker's boundingBox() would be off by that offset. Adding the
 * container's own page rect here, in-page, converts it to the same
 * coordinate space in one step.
 */
export async function getMapLatLngToContainerPoint(page: Page, lat: number, lon: number): Promise<{ x: number; y: number }> {
  return withMap(
    page,
    (map, lat: number, lon: number) => {
      const pt = map.project(lat, lon);
      const rect = map.getContainer().getBoundingClientRect();
      return { x: pt.x + rect.x, y: pt.y + rect.y };
    },
    lat,
    lon,
  );
}

/**
 * Waits until the app has chosen its opening view and made its first viewport
 * request (main.ts sets data-ready on the map container). Drive the map only
 * after this: before it, the opening view can still move the map, and its
 * request lands on top of the test's own.
 */
export async function waitForMapReady(page: Page, timeout = 10_000): Promise<void> {
  await page.waitForSelector('.map-container[data-ready="true"]', { timeout });
}

/**
 * Records the page's requests whose URL matches `match`: `sent` as they go
 * out, `landed` once answered, failed or aborted. `settled()` waits until all
 * have landed and none has followed for `quietMs`. Register before page.goto.
 */
export function trackRequests(page: Page, match: RegExp): { sent: string[]; landed: string[]; settled(quietMs?: number): Promise<void> } {
  const sent: string[] = [];
  const landed: string[] = [];
  page.on("request", (r) => {
    if (match.test(r.url())) sent.push(r.url());
  });
  for (const event of ["requestfinished", "requestfailed"] as const) {
    page.on(event, (r) => {
      if (match.test(r.url())) landed.push(r.url());
    });
  }
  return {
    sent,
    landed,
    async settled(quietMs = 800) {
      await expect
        .poll(
          async () => {
            const n = sent.length;
            await page.waitForTimeout(quietMs);
            return sent.length === n && landed.length === n;
          },
          { timeout: 15_000, message: "requests settled" },
        )
        .toBe(true);
    },
  };
}

/** The centre longitude of a bbox request: which view it was for. */
export function requestCentreLon(url: string): number {
  const q = new URL(url).searchParams;
  return (Number(q.get("lonMin")) + Number(q.get("lonMax"))) / 2;
}

/** The zoom level an overview request is for, from its width: a viewport-wide bbox (snapped outwards a little) at 256 px per 360° at zoom 0. */
export function overviewLevel(page: Page, url: string): number {
  const q = new URL(url).searchParams;
  return Math.round(Math.log2(((page.viewportSize()!.width / 256) * 360) / (Number(q.get("lonMax")) - Number(q.get("lonMin")))));
}

/**
 * Stops the page's clock before it loads: its timers then run only when the
 * test moves time on (page.clock.runFor). For behaviour bounded by the app's
 * own timeouts, which a busy machine could hit before a mocked response is
 * handled. Animation frames stop too, so nothing renders; jumps (setView,
 * jumpTo) still apply.
 */
export async function freezeClock(page: Page): Promise<void> {
  await page.clock.install();
  // A little ahead: the clock runs until this lands, and it can't jump back.
  await page.clock.pauseAt(Date.now() + 5_000);
}

/**
 * An element's box once it has stopped changing: two reads 100 ms apart that
 * agree. A panel that is re-rendering reads null for a moment, and one that is
 * still animating reads a box that is about to change.
 */
export async function settledBox(locator: Locator, timeout = 5_000): Promise<{ x: number; y: number; width: number; height: number }> {
  let prev: Awaited<ReturnType<Locator["boundingBox"]>> = null;
  let box: Awaited<ReturnType<Locator["boundingBox"]>> = null;
  const same = (a: NonNullable<typeof box>, b: NonNullable<typeof box>) =>
    Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 && Math.abs(a.width - b.width) < 0.5 && Math.abs(a.height - b.height) < 0.5;
  await expect
    .poll(
      async () => {
        prev = box;
        box = await locator.boundingBox();
        return prev != null && box != null && same(prev, box);
      },
      { timeout, intervals: [100], message: "element box settled" },
    )
    .toBe(true);
  return box!;
}

export async function setMapView(page: Page, lat: number, lon: number, zoom: number): Promise<void> {
  await withMap(
    page,
    (map, lat: number, lon: number, zoom: number) => {
      map.setView([lat, lon], zoom);
    },
    lat,
    lon,
    zoom,
  );
}

/** A plane as drawn, in page pixels (the space boundingBox() and page.mouse use). */
export type PagePlane = RenderedPlane;

/**
 * Every plane the map's plane layers drew in view (map/planes.ts), with x/y
 * in page pixels: what a user sees, not what the app holds in memory.
 */
export async function renderedPlanes(page: Page): Promise<PagePlane[]> {
  return withMap(page, (map) => {
    const rect = map.getContainer().getBoundingClientRect();
    return map.renderedPlanes().map((p) => ({ ...p, x: p.x + rect.x, y: p.y + rect.y }));
  });
}

/** Every airport the airport layer drew in view (ui/defaultAirports.ts), x/y in page pixels. */
export async function renderedAirports(page: Page): Promise<RenderedAirport[]> {
  return withMap(page, (map) => {
    const rect = map.getContainer().getBoundingClientRect();
    return map.renderedAirports().map((a) => ({ ...a, x: a.x + rect.x, y: a.y + rect.y }));
  });
}

/** Waits until at least `min` planes are drawn. */
export async function waitForPlanes(page: Page, min = 1, timeout = 10_000): Promise<void> {
  await expect.poll(async () => (await renderedPlanes(page)).length, { timeout, message: "planes drawn" }).toBeGreaterThanOrEqual(min);
}

/** Clicks the page at (x, y) once nothing (the boot screen) can intercept it. */
async function clickAt(page: Page, x: number, y: number): Promise<void> {
  await page.locator(".boot-screen:not(.boot-screen--hidden)").waitFor({ state: "detached", timeout: 15_000 });
  await page.mouse.click(x, y);
}

/** A drawn plane, looked up afresh on every call (it moves, and a selection flies the map to it). */
export interface PlaneTarget {
  icao24: string;
  /** Its icon box as drawn, page pixels. */
  boundingBox(): Promise<{ x: number; y: number; width: number; height: number } | null>;
  /** Clicks its centre, like a user would. */
  click(): Promise<void>;
}

export function planeTarget(page: Page, icao24: string): PlaneTarget {
  const find = async () => (await renderedPlanes(page)).find((p) => p.icao24 === icao24) ?? null;
  return {
    icao24,
    async boundingBox() {
      const p = await find();
      return p ? { x: p.x - p.size / 2, y: p.y - p.size / 2, width: p.size, height: p.size } : null;
    },
    async click() {
      const p = await find();
      if (!p) throw new Error(`plane ${icao24} is not drawn`);
      await clickAt(page, p.x, p.y);
    },
  };
}

/**
 * Fixture live data packs 30 real aircraft into a small area, so more than
 * one plane is typically on screen at once. This finds the drawn plane
 * closest to a given aircraft's true projected position.
 */
export async function findMarkerNear(page: Page, lat: number, lon: number): Promise<PlaneTarget> {
  const expected = await getMapLatLngToContainerPoint(page, lat, lon);
  let best: PagePlane | null = null;
  for (const p of await renderedPlanes(page)) {
    if (!best || Math.hypot(p.x - expected.x, p.y - expected.y) < Math.hypot(best.x - expected.x, best.y - expected.y)) best = p;
  }
  if (!best) throw new Error(`No plane drawn near (${lat}, ${lon})`);
  return planeTarget(page, best.icao24);
}

/** Clicks the drawn airport with this code (its dot), like a user would. */
export async function clickAirport(page: Page, code: string): Promise<void> {
  const ap = (await renderedAirports(page)).find((a) => a.code === code);
  if (!ap) throw new Error(`airport ${code} is not drawn`);
  await clickAt(page, ap.x, ap.y);
}

/** The selected aircraft's trail as drawn: the route source's line, [lat, lon] per vertex (map/route.ts). */
export async function getRouteVertices(page: Page): Promise<{ lat: number; lon: number }[]> {
  return withMap(page, async (map) => {
    const source = map.gl.getSource("flight-route") as { getData(): Promise<{ geometry?: { coordinates: [number, number][] } }> } | undefined;
    if (!source) return [];
    const data = await source.getData();
    return (data.geometry?.coordinates ?? []).map(([lon, lat]) => ({ lat, lon }));
  });
}

/** The trail's vertices in page pixels (the space boundingBox() uses). */
export async function getRoutePathScreenPoints(page: Page): Promise<{ x: number; y: number }[]> {
  const vertices = await getRouteVertices(page);
  return withMap(
    page,
    (map, vertices: { lat: number; lon: number }[]) => {
      const rect = map.getContainer().getBoundingClientRect();
      return vertices.map((v) => {
        const pt = map.project(v.lat, v.lon);
        return { x: pt.x + rect.x, y: pt.y + rect.y };
      });
    },
    vertices,
  );
}

/** Serves OpenFreeMap's tileset as empty: the basemap draws its background colour and nothing else. */
export async function stubBasemapTiles(page: Page) {
  await page.route("https://tiles.openfreemap.org/planet", (r) =>
    r.fulfill({ json: { tilejson: "3.0.0", tiles: ["https://tiles.openfreemap.org/t/{z}/{x}/{y}.pbf"], minzoom: 0, maxzoom: 14, vector_layers: [] } }),
  );
  await page.route(/tiles\.openfreemap\.org\/(t|fonts)\//, (r) => r.fulfill({ body: Buffer.alloc(0), contentType: "application/x-protobuf" }));
}
