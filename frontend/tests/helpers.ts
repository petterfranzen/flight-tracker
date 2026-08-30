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

/**
 * Intercepts every network call FlightMap makes and serves fixture data
 * captured once from the real API (see tests/fixtures/) — no docker-compose
 * stack, no live backend, fully deterministic. `historyDelayMs` lets a
 * specific aircraft's /history response be held up artificially, which is
 * how the selection-race regression test (marker-position.spec.ts)
 * reproduces "select A, then B before A's history resolves" on demand.
 */
export async function mockFlightApi(page: Page, opts?: { historyDelayMs?: Record<string, number> }) {
  await page.route("**/api/flights/live/clusters*", (route: Route) => route.fulfill({ json: [] }));
  await page.route("**/api/flights/live*", (route: Route) => route.fulfill({ json: LIVE_FIXTURE }));

  await page.route("**/api/flights/*/history*", async (route: Route) => {
    const url = new URL(route.request().url());
    const icao24 = url.pathname.split("/")[3];
    const delay = opts?.historyDelayMs?.[icao24] ?? 0;
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    await route.fulfill({ json: HISTORIES[icao24] ?? [] });
  });

  await page.route("**/api/aircraft/*", (route: Route) => route.fulfill({ status: 404, json: null }));
  await page.route("**/api/agents/status", (route: Route) => route.fulfill({ json: { active: false, secondsRemaining: 0 } }));

  // Accept the WebSocket connection so subscribeLiveFeed doesn't error, but
  // never send anything — these tests exercise the REST paths (initial
  // /live paint, /history on selection, the reconcile fetch), not the live
  // push feed.
  await page.routeWebSocket("**/ws/live", () => {});
}

// Finds the mounted Leaflet map instance by walking the React fiber tree
// from #root, in-page — react-leaflet doesn't expose it on `window`, and
// the app has no test-only hook for it (deliberately: not worth adding
// production code whose only purpose is being read by tests). Matches on
// duck-typed shape (getZoom + getBounds) since the production bundle is
// minified and has no stable class name to search for. Injected as a
// string (see withMap below) so it runs inside the page, not this Node
// process.
const FIND_MAP_SNIPPET = `
  function __findLeafletMap() {
    const rootEl = document.getElementById("root");
    const key = Object.keys(rootEl).find((k) => k.startsWith("__reactContainer"));
    const rootFiber = rootEl[key];
    let found = null;
    const seen = new Set();
    function looksLikeMap(v) {
      return v && typeof v === "object" && typeof v.getZoom === "function" && typeof v.getBounds === "function";
    }
    function tryVal(v) {
      if (looksLikeMap(v)) return v;
      if (v && typeof v === "object" && looksLikeMap(v.map)) return v.map;
      if (v && typeof v === "object" && looksLikeMap(v.current)) return v.current;
      return null;
    }
    function dfs(node, depth) {
      if (!node || found || depth > 400 || seen.has(node)) return;
      seen.add(node);
      const mp = node.memoizedProps;
      if (mp) { const r = tryVal(mp.value); if (r) { found = r; return; } }
      const r2 = tryVal(node.stateNode);
      if (r2) { found = r2; return; }
      let hook = node.memoizedState;
      let hc = 0;
      while (hook && hc < 30) {
        const r3 = tryVal(hook.memoizedState);
        if (r3) { found = r3; return; }
        hook = hook.next; hc++;
      }
      dfs(node.child, depth + 1);
      if (found) return;
      dfs(node.sibling, depth + 1);
    }
    dfs(rootFiber, 0);
    if (!found) throw new Error("Leaflet map instance not found in React tree");
    return found;
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

/** Parses a Leaflet-rendered SVG path's "M x y L x y ..." into pixel points. */
export function parsePathPoints(d: string): { x: number; y: number }[] {
  const nums = d.match(/-?\d+(\.\d+)?/g)?.map(Number) ?? [];
  const points: { x: number; y: number }[] = [];
  for (let i = 0; i + 1 < nums.length; i += 2) {
    points.push({ x: nums[i], y: nums[i + 1] });
  }
  return points;
}
