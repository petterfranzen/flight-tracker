import { expect, test, type Page, type Route } from "@playwright/test";
import { clusterPositions } from "../src/map/clusterMath";
import { fleet10k, FLEET_SIZE, type FleetAircraft } from "./fixtures/fleet10k";
import { withMap } from "./helpers";

// Main-thread budget for any single task while zooming and selecting with a
// realistic worldwide fleet. 200ms is "the UI visibly froze"; before this
// suite existed, a zoom-out from a busy area produced ~1s tasks here at 10k
// aircraft and the page hung outright at 100k.
const LONG_TASK_BUDGET_MS = 200;
// A wall-clock budget means different things on different machines, and on
// the same machine under load: a shared CI runner that is descheduled for 100
// ms inflates a task the app only needed 60 ms of CPU for. So the budget is
// 200 ms *on the reference machine* and is scaled by how slow this one is
// right now, measured with a fixed CPU benchmark in a throwaway page (a
// separate renderer, so it never lands in the observed page's long tasks).
// The scale is capped: a real regression (the ~1 s tasks this suite was
// written for) must still fail.
const CALIBRATION_REFERENCE_MS = 15; // median of the benchmark on an idle reference machine
const MAX_SLOWDOWN = 4;
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
const OVERVIEW_PLANES = 120; // the server's default overview size

/** >= 1; how many times slower than the reference machine this one is right now. */
async function cpuSlowdown(page: Page): Promise<number> {
  const scratch = await page.context().newPage();
  try {
    const medianMs = await scratch.evaluate(async () => {
      const runs: number[] = [];
      for (let k = 0; k < 9; k++) {
        const t0 = performance.now();
        let x = 0;
        for (let i = 0; i < 1_500_000; i++) x += Math.sqrt(i) * Math.sin(i);
        runs.push(performance.now() - t0 + (x === 42 ? 1 : 0));
        await new Promise((r) => setTimeout(r, 0)); // yield, so each run is its own task
      }
      runs.sort((a, b) => a - b);
      return runs[4];
    });
    return Math.min(MAX_SLOWDOWN, Math.max(1, medianMs / CALIBRATION_REFERENCE_MS));
  } finally {
    await scratch.close();
  }
}

// The budget measures this app's own main-thread work, so it runs on the
// plain theme. The cyberpunk theme (the default since it became one) adds
// a MapLibre WebGL basemap, and CI runners have no GPU: Chromium renders
// WebGL in software there, which alone costs tens of long tasks per zoom
// and says nothing about the app or about a real browser with a GPU.
// PERF_THEME=cyberpunk runs the same scenario on it for a manual look.
const PERF_THEME = process.env.PERF_THEME === "cyberpunk" ? "cyberpunk" : "default";

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
async function mockTenThousand(page: Page, opts: { holdLive?: boolean; liveFeed?: boolean; quietWorldSummary?: boolean } = {}) {
  const fleet = fleet10k();
  const now = new Date().toISOString();
  const requests: ViewportRequest[] = [];
  const restarts: string[] = [];
  // With holdLive, /live responses wait for releaseLive() instead of for a
  // timer, so a test can keep a request "in flight" for exactly as long as it
  // needs, however slow the machine running it is.
  let releaseLive: () => void = () => {};
  const liveGate = new Promise<void>((resolve) => {
    releaseLive = resolve;
  });

  await page.route("**/api/flights/live/count*", (route) => route.fulfill({ json: FLEET_SIZE }));
  // Zoomed-out fetch: the server's overview — top OVERVIEW_PLANES by speed as
  // markers, the rest clustered.
  await page.route("**/api/flights/live/overview*", async (route) => {
    const url = new URL(route.request().url());
    const b = bboxOf(url)!;
    const grid = Math.min(25, Math.max(0.5, Number(url.searchParams.get("gridDeg") ?? 2)));
    const inView = fleet.filter((a) => a.latitude >= b.latMin && a.latitude <= b.latMax && a.longitude >= b.lonMin && a.longitude <= b.lonMax).map((a) => marker(a, now));
    const planes = inView.slice(0, OVERVIEW_PLANES);
    requests.push({ kind: "clusters", bbox: b, bytes: await fulfill(route, { planes, clusters: clusterPositions(inView.slice(OVERVIEW_PLANES), grid) }) });
  });
  await page.route("**/api/flights/live/clusters*", async (route) => {
    const url = new URL(route.request().url());
    const b = bboxOf(url)!;
    const grid = Math.min(25, Math.max(0.5, Number(url.searchParams.get("gridDeg") ?? 2)));
    // The boot-time world summary (see map/initialView.ts) decides where the
    // map opens. quietWorldSummary answers it with nothing, so the map keeps
    // its default clustered view: for tests about viewport changes *from* that
    // view, not about the opening view (which has its own tests).
    if (opts.quietWorldSummary && b.latMin <= -89 && b.latMax >= 89) {
      requests.push({ kind: "clusters", bbox: b, bytes: await fulfill(route, []) });
      return;
    }
    // The server's own bucketing (clusters at the mean position of their aircraft).
    const inView = fleet.filter((a) => a.latitude >= b.latMin && a.latitude <= b.latMax && a.longitude >= b.lonMin && a.longitude <= b.lonMax).map((a) => marker(a, now));
    requests.push({ kind: "clusters", bbox: b, bytes: await fulfill(route, clusterPositions(inView, grid)) });
  });
  await page.route(/\/api\/flights\/live(\?|$)/, async (route) => {
    const b = bboxOf(new URL(route.request().url()));
    const list = fleet
      .filter((a) => !b || (a.latitude >= b.latMin && a.latitude <= b.latMax && a.longitude >= b.lonMin && a.longitude <= b.lonMax))
      .map((a) => marker(a, now));
    if (opts.holdLive) await liveGate;
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

  return { requests, restarts, hotCount: hot.length, releaseLive: () => releaseLive() };
}

async function startLongTaskObserver(page: Page) {
  await page.addInitScript((theme) => {
    localStorage.setItem("flighttracker:theme", theme);
    const w = window as unknown as { __longTasks: number[] };
    w.__longTasks = [];
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) w.__longTasks.push(Math.round(e.duration));
    }).observe({ type: "longtask", buffered: true });
  }, PERF_THEME);
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
    const slowdownBefore = await cpuSlowdown(page);
    await startLongTaskObserver(page);
    const api = await mockTenThousand(page, { liveFeed: true });
    await page.goto("/");
    await page.waitForSelector(".cluster-icon, .plane-icon", { timeout: 15_000 });
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

    const slowdown = Math.max(slowdownBefore, await cpuSlowdown(page));
    const budgetMs = LONG_TASK_BUDGET_MS * slowdown;

    const live = api.requests.filter((r) => r.kind === "live");
    const metrics = {
      slowdown: Number(slowdown.toFixed(2)),
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

    expect(longTasks.filter((d) => d > budgetMs), `long tasks: ${longTasks.join(", ")}ms (budget ${Math.round(budgetMs)}ms = ${LONG_TASK_BUDGET_MS}ms x ${slowdown.toFixed(2)} slowdown)`).toEqual([]);
    expect(selectMs).toBeLessThan(1_000 * slowdown);
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
    // The first /live response is held until released: "in flight" lasts as
    // long as the test says, not as long as a timer happens to.
    const api = await mockTenThousand(page, { holdLive: true, quietWorldSummary: true });
    const started: string[] = [];
    const aborted: string[] = [];
    page.on("request", (r) => {
      if (/\/api\/flights\/live\?/.test(r.url())) started.push(r.url());
    });
    page.on("requestfailed", (r) => {
      if (/\/api\/flights\/live\?/.test(r.url())) aborted.push(r.url());
    });
    await page.goto("/");
    await page.waitForSelector(".cluster-icon, .plane-icon", { timeout: 15_000 });

    // Five moveends in a single task, so they are inside the debounce window
    // however slow the machine: one request.
    await withMap(page, (map) => {
      for (const lon of [-0.9, -0.7, -0.5, -0.3, -0.1]) map.setView([51.5, lon], 9, { animate: false });
    });
    await expect.poll(() => started.length, { timeout: 10_000 }).toBe(1);
    // Past the debounce window, still just the one.
    await page.waitForTimeout(600);
    expect(started).toHaveLength(1);
    expect(new URL(started[0]).searchParams.get("lonMin")).toBe(String(await withMap(page, (map) => map.getBounds().getWest())));

    // That request is still held, i.e. in flight: move again. It gets
    // aborted, and only the newer viewport is requested after it.
    await withMap(page, (map) => {
      map.setView([51.6, 0.2], 9, { animate: false });
    });
    await expect.poll(() => aborted.length, { timeout: 10_000 }).toBe(1);
    await expect.poll(() => started.length, { timeout: 10_000 }).toBe(2);
    expect(aborted[0]).toBe(started[0]);
    api.releaseLive();
  });
});
