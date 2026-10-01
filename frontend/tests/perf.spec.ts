import { expect, test, type Page, type Route } from "@playwright/test";
import { fleet10k, FLEET_SIZE, type FleetAircraft } from "./fixtures/fleet10k";
import { withMap } from "./helpers";

// Main-thread budget for any single task while zooming and selecting with a
// realistic worldwide fleet. 200ms is "the UI visibly froze"; before this
// suite existed, a zoom-out from a busy area produced ~1s tasks here at 10k
// aircraft and the page hung outright at 100k.
const LONG_TASK_BUDGET_MS = 200;
// CLUSTER_FETCH_MAX_ZOOM in main.ts.
const CLUSTER_FETCH_MAX_ZOOM = 8;
const VIEWPORT = { width: 1280, height: 800 };
// Longitude span of the viewport at CLUSTER_FETCH_MAX_ZOOM (Web Mercator,
// 256px tiles), plus slack — any /live request wider than this was made
// below the cluster zoom.
const MAX_LIVE_LON_SPAN = (VIEWPORT.width / 256 / 2 ** CLUSTER_FETCH_MAX_ZOOM) * 360 * 1.1;
// Roughly a Cloudflare round trip, so in-flight requests really overlap
// with user input.
const API_LATENCY_MS = 80;

const LONDON = { lat: 51.5, lon: -0.5 };

interface ViewportRequest {
  kind: "live" | "clusters";
  bbox: { latMin: number; latMax: number; lonMin: number; lonMax: number } | null;
  bytes: number;
}

function marker(a: FleetAircraft, observedAt: string) {
  return { icao24: a.icao24, callsign: a.callsign, observedAt, latitude: a.latitude, longitude: a.longitude, headingDeg: a.headingDeg };
}

function position(a: FleetAircraft, observedAt: string) {
  return {
    ...marker(a, observedAt),
    id: 0,
    altitudeM: a.altitudeM,
    velocityMs: a.velocityMs,
    verticalRateMs: 0,
    onGround: false,
    agentSource: "opensky",
  };
}

function bboxOf(url: URL) {
  const p = url.searchParams;
  if (!p.has("latMin")) return null;
  return { latMin: Number(p.get("latMin")), latMax: Number(p.get("latMax")), lonMin: Number(p.get("lonMin")), lonMax: Number(p.get("lonMax")) };
}

async function fulfill(route: Route, json: unknown): Promise<number> {
  const body = JSON.stringify(json);
  await new Promise((r) => setTimeout(r, API_LATENCY_MS));
  // The app aborts superseded viewport requests; fulfilling one of those throws.
  await route.fulfill({ body, contentType: "application/json" }).catch(() => {});
  return body.length;
}

/**
 * The backend, as far as the map can tell, with 10,000 aircraft live:
 * /live filtered by bbox and /live/clusters bucketed exactly the way
 * LiveStateStore does it, plus a WebSocket that pushes a hot-poll-sized
 * burst of ~1,000 positions every 2s — the real hot poll is every 18s — and
 * a keepalive text frame after each burst.
 */
async function mockTenThousand(page: Page, opts: { liveDelayMs?: number; liveFeed?: boolean } = {}) {
  const fleet = fleet10k();
  const now = new Date().toISOString();
  const requests: ViewportRequest[] = [];
  const restarts: string[] = [];

  await page.route("**/api/flights/live/count", (route) => route.fulfill({ json: FLEET_SIZE }));
  await page.route("**/api/flights/live/clusters*", async (route) => {
    const url = new URL(route.request().url());
    const b = bboxOf(url)!;
    const grid = Math.min(25, Math.max(0.5, Number(url.searchParams.get("gridDeg") ?? 2)));
    const cells = new Map<string, { lat: number; lon: number; count: number }>();
    for (const a of fleet) {
      if (a.latitude < b.latMin || a.latitude > b.latMax || a.longitude < b.lonMin || a.longitude > b.lonMax) continue;
      const lat = Math.floor(a.latitude / grid) * grid;
      const lon = Math.floor(a.longitude / grid) * grid;
      const key = `${lat},${lon}`;
      const cell = cells.get(key);
      if (cell) cell.count++;
      else cells.set(key, { lat: lat + grid / 2, lon: lon + grid / 2, count: 1 });
    }
    requests.push({ kind: "clusters", bbox: b, bytes: await fulfill(route, [...cells.values()]) });
  });
  await page.route(/\/api\/flights\/live(\?|$)/, async (route) => {
    const b = bboxOf(new URL(route.request().url()));
    const list = fleet
      .filter((a) => !b || (a.latitude >= b.latMin && a.latitude <= b.latMax && a.longitude >= b.lonMin && a.longitude <= b.lonMax))
      .map((a) => marker(a, now));
    if (opts.liveDelayMs) await new Promise((r) => setTimeout(r, opts.liveDelayMs));
    const entry: ViewportRequest = { kind: "live", bbox: b, bytes: 0 };
    requests.push(entry);
    entry.bytes = await fulfill(route, list);
  });
  await page.route("**/api/flights/*/live", (route) => {
    const icao24 = new URL(route.request().url()).pathname.split("/")[3];
    const a = fleet.find((x) => x.icao24 === icao24);
    return a ? route.fulfill({ json: position(a, now) }) : route.fulfill({ status: 404, json: null });
  });
  await page.route("**/api/flights/*/history*", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/aircraft/*", (route) => route.fulfill({ status: 404, json: null }));
  await page.route("**/api/agents/status", (route) => route.fulfill({ json: { active: true, secondsRemaining: 300 } }));
  await page.route("**/api/agents/restart", (route) => {
    restarts.push(route.request().url());
    return route.fulfill({ json: { active: true, secondsRemaining: 300 } });
  });

  const hot = fleet.filter((a) => Math.abs(a.latitude - LONDON.lat) < 3 && Math.abs(a.longitude - LONDON.lon) < 5);
  if (opts.liveFeed) {
    // Faked in-page rather than with page.routeWebSocket: that relays every
    // frame through the test process over CDP, and at ~1,000 frames a burst
    // the harness itself became the bottleneck. The app still receives real
    // MessageEvents through its own onmessage handler.
    await page.addInitScript(
      ({ hot }) => {
        class FakeLiveFeed {
          static CONNECTING = 0;
          static OPEN = 1;
          static CLOSING = 2;
          static CLOSED = 3;
          readyState = 0;
          url: string;
          onopen: ((e: Event) => void) | null = null;
          onmessage: ((e: MessageEvent) => void) | null = null;
          onclose: ((e: CloseEvent) => void) | null = null;
          onerror: ((e: Event) => void) | null = null;
          private timer: ReturnType<typeof setInterval> | undefined;
          constructor(url: string) {
            this.url = url;
            let tick = 0;
            setTimeout(() => {
              this.readyState = 1;
              this.onopen?.(new Event("open"));
              this.timer = setInterval(() => {
                tick++;
                const observedAt = new Date().toISOString();
                for (const a of hot) {
                  const data = JSON.stringify({
                    ...a,
                    latitude: a.latitude + tick * 0.001,
                    headingDeg: (a.headingDeg + tick) % 360,
                    observedAt,
                    id: 0,
                    verticalRateMs: 0,
                    onGround: false,
                    agentSource: "opensky",
                  });
                  this.onmessage?.(new MessageEvent("message", { data }));
                }
                this.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ type: "ping" }) }));
              }, 2_000);
            }, 50);
          }
          send(): void {}
          close(): void {
            clearInterval(this.timer);
            this.readyState = 3;
          }
        }
        (window as unknown as { WebSocket: unknown }).WebSocket = FakeLiveFeed;
      },
      { hot },
    );
  } else {
    await page.routeWebSocket("**/ws/live", () => {});
  }

  return { requests, restarts, hotCount: hot.length };
}

async function startLongTaskObserver(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __longTasks: number[] };
    w.__longTasks = [];
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) w.__longTasks.push(Math.round(e.duration));
    }).observe({ type: "longtask", buffered: true });
  });
}

const takeLongTasks = (page: Page) =>
  page.evaluate(() => (window as unknown as { __longTasks: number[] }).__longTasks.splice(0));

// Animated, like a real wheel/button zoom — the expensive path. Block
// bodies on purpose: returning the Leaflet map from page.evaluate makes
// Playwright serialize its whole object graph in-page, a 100ms+ long task
// of the test's own making.
const zoomTo = (page: Page, z: number) =>
  withMap(
    page,
    (map, z: number) => {
      map.setZoom(z);
    },
    z,
  );
const flyTo = (page: Page, lat: number, lon: number, z: number) =>
  withMap(
    page,
    (map, lat: number, lon: number, z: number) => {
      map.setView([lat, lon], z);
    },
    lat,
    lon,
    z,
  );

test.describe("performance with 10,000 live aircraft @perf", () => {
  test.use({ viewport: VIEWPORT });

  test("zooming and selecting never blocks the main thread for more than 200ms", async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    await startLongTaskObserver(page);
    const api = await mockTenThousand(page, { liveFeed: true });
    await page.goto("/");
    await page.waitForSelector(".cluster-icon", { timeout: 15_000 });
    await page.waitForTimeout(500);

    const longTasks: number[] = [...(await takeLongTasks(page))];

    // Into the busiest area and through the cluster threshold both ways,
    // while the WebSocket keeps pushing ~1k-position bursts.
    await flyTo(page, LONDON.lat, LONDON.lon, 8);
    await page.waitForTimeout(800);
    for (const z of [9, 10, 9, 7, 6, 8, 9, 10]) {
      await zoomTo(page, z);
      await page.waitForTimeout(600);
    }
    await flyTo(page, LONDON.lat, LONDON.lon, 11);
    await page.locator(".plane-icon:not(.plane-icon--exiting)").first().waitFor({ timeout: 10_000 });
    await page.waitForTimeout(500);
    // One that's actually on screen (and clear of the left-hand overlays).
    await page.evaluate(() => {
      const ok = Array.from(document.querySelectorAll<HTMLElement>(".plane-icon:not(.plane-icon--exiting)")).find((el) => {
        const r = el.getBoundingClientRect();
        return r.left > window.innerWidth * 0.4 && r.right < window.innerWidth - 20 && r.top > 80 && r.bottom < window.innerHeight - 80;
      });
      ok?.setAttribute("data-perf-target", "");
    });
    const plane = page.locator("[data-perf-target]");
    longTasks.push(...(await takeLongTasks(page)));

    const t0 = Date.now();
    await plane.click({ force: true });
    await page.locator("#details-panel-heading").waitFor();
    const selectMs = Date.now() - t0;
    await page.waitForTimeout(1_500); // the selection's flyTo + follow-up fetches
    longTasks.push(...(await takeLongTasks(page)));

    await zoomTo(page, 4);
    await page.waitForTimeout(1_500);
    longTasks.push(...(await takeLongTasks(page)));

    const live = api.requests.filter((r) => r.kind === "live");
    const metrics = {
      longTasks: longTasks.length,
      maxLongTaskMs: Math.max(0, ...longTasks),
      selectMs,
      liveRequests: live.length,
      maxLiveBytes: Math.max(0, ...live.map((r) => r.bytes)),
      clusterRequests: api.requests.length - live.length,
      wsBurstSize: api.hotCount,
    };
    testInfo.annotations.push({ type: "perf", description: JSON.stringify(metrics) });
    console.log("perf:", JSON.stringify(metrics));

    expect(longTasks.filter((d) => d > LONG_TASK_BUDGET_MS), `long tasks: ${longTasks.join(", ")}ms`).toEqual([]);
    expect(selectMs).toBeLessThan(1_000);
    // /live only ever for an individual-marker viewport — never bbox-less
    // (world-wide), never below the cluster zoom.
    for (const r of live) {
      expect(r.bbox, "world-wide /api/flights/live request").not.toBeNull();
      expect(r.bbox!.lonMax - r.bbox!.lonMin).toBeLessThan(MAX_LIVE_LON_SPAN);
    }
    expect(api.restarts).toEqual([]);
  });

  test("a burst of viewport changes makes one request, and a newer viewport aborts the one in flight", async ({ page }) => {
    test.setTimeout(60_000);
    await mockTenThousand(page, { liveDelayMs: 1_500 });
    const started: string[] = [];
    const aborted: string[] = [];
    page.on("request", (r) => {
      if (/\/api\/flights\/live\?/.test(r.url())) started.push(r.url());
    });
    page.on("requestfailed", (r) => {
      if (/\/api\/flights\/live\?/.test(r.url())) aborted.push(r.url());
    });
    await page.goto("/");
    await page.waitForSelector(".cluster-icon", { timeout: 15_000 });

    // Five moveends inside the debounce window → one request.
    // In-page, 50ms apart — like wheel ticks; separate page.evaluate round
    // trips would each take longer than the debounce window on their own.
    await withMap(page, async (map) => {
      for (const lon of [-0.9, -0.7, -0.5, -0.3, -0.1]) {
        map.setView([51.5, lon], 9, { animate: false });
        await new Promise((r) => setTimeout(r, 50));
      }
    });
    await page.waitForTimeout(700);
    expect(started).toHaveLength(1);
    expect(new URL(started[0]).searchParams.get("lonMin")).toBe(String(await withMap(page, (map) => map.getBounds().getWest())));

    // While that (slow) request is in flight, move again: it gets aborted,
    // and only the newer viewport is requested after it.
    await withMap(page, (map) => {
      map.setView([51.6, 0.2], 9, { animate: false });
    });
    await expect.poll(() => aborted.length, { timeout: 5_000 }).toBe(1);
    await expect.poll(() => started.length, { timeout: 5_000 }).toBe(2);
    expect(aborted[0]).toBe(started[0]);
  });
});
