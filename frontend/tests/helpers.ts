import type { Page, Route } from "@playwright/test";
import type L from "leaflet";
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
export async function mockFlightApi(page: Page, opts?: { historyDelayMs?: Record<string, number>; clusters?: ClusterPointFixture[] }) {
  await page.route("**/api/flights/live/clusters*", (route: Route) => route.fulfill({ json: opts?.clusters ?? [] }));
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

  // Accept the WebSocket connection so subscribeLiveFeed doesn't error, but
  // never send anything — these tests exercise the REST paths (initial
  // /live paint, /history on selection, the reconcile fetch), not the live
  // push feed.
  await page.routeWebSocket("**/ws/live", () => {});
}

// Finds the mounted Leaflet map instance, in-page. Vanilla TS (no React
// fiber tree to walk anymore — see map/map.ts's createMap, which stashes
// the instance directly on its own container element the moment it's
// created: `container._leaflet_map = map`). That's a narrower surface than
// the old React-fiber DFS this replaced (a single property read on a
// single element, versus walking the whole component tree with a duck-typed
// guess), and it's scoped to `.leaflet-container` specifically so it can
// never accidentally match an unrelated element. Injected as a string (see
// withMap below) so it runs inside the page, not this Node process.
const FIND_MAP_SNIPPET = `
  function __findLeafletMap() {
    const el = document.querySelector(".leaflet-container");
    const map = el && el._leaflet_map;
    if (!map) throw new Error("Leaflet map instance not found (.leaflet-container has no _leaflet_map)");
    return map;
  }
`;

/**
 * Runs `fn(map, ...args)` inside the page against the live Leaflet map
 * instance. `fn` is serialized via toString() and reconstructed in-page —
 * it must be self-contained (only reference `map` and `args`, never
 * variables closed over from the Node-side test file, which don't survive
 * that serialization) and `args` must be JSON-serializable.
 */
export async function withMap<T, A extends unknown[]>(page: Page, fn: (map: L.Map, ...args: A) => T, ...args: A): Promise<T> {
  return page.evaluate(
    ({ snippet, fnStr, args }) => {
      // eslint-disable-next-line no-eval
      const findMap = eval(`(function() { ${snippet}; return __findLeafletMap(); })`);
      const map = findMap();
      // eslint-disable-next-line no-eval
      const action = eval(`(${fnStr})`);
      return action(map, ...args);
    },
    { snippet: FIND_MAP_SNIPPET, fnStr: fn.toString(), args },
  );
}

/**
 * The expected on-*page* pixel position for a lat/lon, matching what
 * Playwright's boundingBox() returns for elements (viewport-relative).
 * map.latLngToContainerPoint() alone isn't that — it's relative to the map
 * container's own top-left, which sits below the app header, so comparing
 * it directly against a marker's boundingBox() is off by exactly that
 * header's height. Adding the container's own page rect here, in-page,
 * converts it to the same coordinate space in one step.
 */
export async function getMapLatLngToContainerPoint(page: Page, lat: number, lon: number): Promise<{ x: number; y: number }> {
  return withMap(
    page,
    (map, lat: number, lon: number) => {
      const pt = map.latLngToContainerPoint([lat, lon]);
      const rect = map.getContainer().getBoundingClientRect();
      return { x: pt.x + rect.x, y: pt.y + rect.y };
    },
    lat,
    lon,
  );
}

export async function setMapView(page: Page, lat: number, lon: number, zoom: number): Promise<void> {
  await withMap(
    page,
    (map, lat: number, lon: number, zoom: number) => {
      map.setView([lat, lon], zoom, { animate: false });
    },
    lat,
    lon,
    zoom,
  );
}

/**
 * Fixture live data packs 30 real aircraft into a small area, so more
 * than one `.plane-icon` is typically on screen at once — `.first()`
 * picks whichever happens to be first in DOM order, not the one under
 * test. This finds the marker actually closest to a given aircraft's true
 * projected position instead.
 */
export async function findMarkerNear(page: Page, lat: number, lon: number): Promise<import("@playwright/test").Locator> {
  const expected = await getMapLatLngToContainerPoint(page, lat, lon);
  const markers = page.locator(".plane-icon");
  const count = await markers.count();
  let bestIndex = -1;
  let bestDist = Infinity;
  for (let i = 0; i < count; i++) {
    const box = await markers.nth(i).boundingBox();
    if (!box) continue;
    const dx = box.x + box.width / 2 - expected.x;
    const dy = box.y + box.height / 2 - expected.y;
    const dist = Math.hypot(dx, dy);
    if (dist < bestDist) {
      bestDist = dist;
      bestIndex = i;
    }
  }
  if (bestIndex === -1) throw new Error(`No .plane-icon marker found near (${lat}, ${lon})`);
  return markers.nth(bestIndex);
}

/**
 * A Leaflet SVG path's `d` attribute is written in the renderer's own
 * user-space, not page pixels — its numbers only equal on-screen position
 * when the map's internal pixel origin and pane offset both happen to be
 * zero. That's not guaranteed: setView's `{animate: false}` still takes
 * Leaflet's "quick pan" shortcut for a same-zoom move that's smaller than
 * the viewport (_tryAnimatedPan → _rawPanBy), which shifts the map pane via
 * a CSS transform instead of resetting the pixel origin, leaving raw `d`
 * coordinates offset from the true screen position by exactly that pan
 * delta — the path itself still renders in the right place on screen
 * (Leaflet composes the same compensating transform back in via the pane/
 * renderer container), only a naive read of `d` disagrees with it. Feeding
 * each parsed vertex through the path element's own screenCTM applies
 * every ancestor transform Leaflet actually used, so it matches reality
 * regardless of which internal code path produced it.
 */
export async function getRoutePathScreenPoints(page: Page): Promise<{ x: number; y: number }[]> {
  return page.evaluate(() => {
    const path = document.querySelector("path.route-line") as SVGPathElement | null;
    if (!path || !path.ownerSVGElement) return [];
    const ctm = path.getScreenCTM();
    if (!ctm) return [];
    const nums = (path.getAttribute("d") ?? "").match(/-?\d+(\.\d+)?/g)?.map(Number) ?? [];
    const points: { x: number; y: number }[] = [];
    for (let i = 0; i + 1 < nums.length; i += 2) {
      const pt = path.ownerSVGElement.createSVGPoint();
      pt.x = nums[i];
      pt.y = nums[i + 1];
      const screenPt = pt.matrixTransform(ctm);
      points.push({ x: screenPt.x, y: screenPt.y });
    }
    return points;
  });
}
