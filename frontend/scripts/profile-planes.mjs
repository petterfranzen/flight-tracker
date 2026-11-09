#!/usr/bin/env node
// Repeatable render profile for renderAircraftLayer at N in-view planes.
// Serves a synthetic fleet over the app's API routes (no backend, no real
// tiles), drives pan / zoom / idle, and prints one row per run. This is the
// method behind docs/perf/PROFILE-2026-11-planes.md; keep the route stubs in
// step with tests/helpers.ts when the API changes.
//
// Usage: node scripts/profile-planes.mjs [N ...]   (default 500 1000 2000 3000)
// Needs the dev server on 5174: npm run dev -- --port 5174 --strictPort.
// PW_CHROMIUM_PATH=/path/to/chrome overrides the bundled browser.

import { chromium } from "@playwright/test";

const BASE = process.env.BASE_URL ?? "http://localhost:5174";
const SIZES = process.argv.slice(2).map(Number).filter(Boolean);
const RUNS = SIZES.length ? SIZES : [500, 1000, 2000, 3000];
const VIEW = { width: 1280, height: 800 };
const CENTRE = { lat: 51.5074, lon: -0.1278 };

// N planes in a 0.5 deg box: all of them are in the viewport at z10 (1.76 deg
// of longitude across 1280 px at this latitude), so the render pass sees the
// whole set. A grid rather than random, so every size is a superset of the
// smaller ones and runs compare like with like.
function fleet(n) {
  const now = new Date().toISOString();
  const side = Math.ceil(Math.sqrt(n));
  const out = [];
  for (let i = 0; i < n; i++) {
    const row = Math.floor(i / side);
    const col = i % side;
    out.push({
      id: i,
      icao24: i.toString(16).padStart(6, "0"),
      callsign: `PRF${String(i).padStart(4, "0")}`,
      observedAt: now,
      latitude: CENTRE.lat - 0.25 + (0.5 * row) / Math.max(1, side - 1),
      longitude: CENTRE.lon - 0.25 + (0.5 * col) / Math.max(1, side - 1),
      altitudeM: 10_000,
      velocityMs: 230,
      headingDeg: (i * 37) % 360,
      verticalRateMs: 0,
      onGround: false,
      agentSource: "profile",
    });
  }
  return out;
}

async function run(browser, n) {
  const context = await browser.newContext({ viewport: VIEW, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const planes = fleet(n);
  let active = planes;
  await page.route("https://tiles.openfreemap.org/planet", (r) =>
    r.fulfill({
      json: {
        tilejson: "3.0.0",
        tiles: ["https://tiles.openfreemap.org/t/{z}/{x}/{y}.pbf"],
        minzoom: 0,
        maxzoom: 14,
      },
    }),
  );
  await page.route(/tiles\.openfreemap\.org\/(t|fonts)\//, (r) =>
    r.fulfill({ body: Buffer.alloc(0), contentType: "application/x-protobuf" }),
  );
  await page.route("**/api/flights/live/count*", (r) => r.fulfill({ json: n }));
  await page.route("**/api/flights/live/overview*", (r) => r.fulfill({ json: { planes: active, clusters: [] } }));
  await page.route("**/api/flights/live/clusters*", (r) => r.fulfill({ json: [] }));
  await page.route(/\/api\/flights\/live(\?|$)/, (r) => {
    const u = new URL(r.request().url());
    const q = u.searchParams;
    const inView = !q.has("latMin")
      ? active
      : active.filter(
          (p) =>
            p.latitude >= Number(q.get("latMin")) &&
            p.latitude <= Number(q.get("latMax")) &&
            p.longitude >= Number(q.get("lonMin")) &&
            p.longitude <= Number(q.get("lonMax")),
        );
    return r.fulfill({ json: inView });
  });
  await page.route("**/api/flights/*/live", (r) => {
    const id = new URL(r.request().url()).pathname.split("/")[3];
    const p = active.find((x) => x.icao24 === id);
    return p ? r.fulfill({ json: { ...p, altitudeM: 10_000, velocityMs: 230, verticalRateMs: 0 } }) : r.fulfill({ status: 404, json: null });
  });
  await page.route("**/api/flights/*/history*", (r) => r.fulfill({ json: [] }));
  await page.route("**/api/aircraft/*", (r) => r.fulfill({ status: 404, json: null }));
  await page.route("**/api/geo", (r) => r.fulfill({ json: null }));
  await page.route("**/api/agents/status", (r) => r.fulfill({ json: { active: true, secondsRemaining: 300 } }));
  await page.route("**/api/agents/restart", (r) => r.fulfill({ json: { active: true, secondsRemaining: 300 } }));
  await page.routeWebSocket("**/ws/live", () => {});

  await page.addInitScript(() => {
    const w = window;
    w.__frames = [];
    let last = 0;
    const tick = (t) => {
      if (last) w.__frames.push(t - last);
      last = t;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  await page.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 120_000 });
  await page.waitForSelector('.map-container[data-ready="true"]', { timeout: 120_000 });
  await page.evaluate(({ lat, lon }) => {
    document.querySelector(".map-container")._flightMap.setView([lat, lon], 10, { animate: false });
  }, CENTRE);
  await page.waitForFunction(() => (document.querySelector('.map-container')?._flightMap?.renderedPlanes?.() ?? []).length > 0, null, { timeout: 60_000 });
  // Let the z10 fetch land and the first render settle.
  await page.waitForTimeout(1500);

  const read = () =>
    page.evaluate(() => {
      const p = window.__flightPerf;
      return {
        render: { ...p.render },
        declutter: { ...p.declutter },
        setData: { ...p.setData },
        parts: { ...p.parts },
        drawn: document.querySelector('.map-container')._flightMap.renderedPlanes().length,
      };
    });
  const reset = () => page.evaluate(() => window.__flightPerfReset());
  const frames = async () => {
    const f = await page.evaluate(() => window.__frames.splice(0));
    f.sort((a, b) => a - b);
    const median = f[Math.floor(f.length / 2)] ?? 16.7;
    return { frames: f.length, dropped: f.filter((d) => d > median * 2).length, median: Number(median.toFixed(1)) };
  };

  const phases = {};
  // Idle: 2s with no viewport change. Only app timers may render.
  await reset();
  await frames();
  await page.waitForTimeout(2000);
  phases.idle = { ...(await read()), ...(await frames()) };

  // Pan: three small jumps, each a new viewport report and a render.
  await reset();
  await frames();
  for (const d of [0.15, 0.3, 0.15]) {
    await page.evaluate(({ lat, lon }) => {
      document.querySelector(".map-container")._flightMap.setView([lat, lon], 10, { animate: false });
    }, { lat: CENTRE.lat, lon: CENTRE.lon + d });
    await page.waitForTimeout(700);
  }
  phases.pan = { ...(await read()), ...(await frames()) };

  // Zoom: out and back in across the render thresholds.
  await reset();
  await frames();
  for (const z of [9.5, 10.5, 9.5, 10]) {
    await page.evaluate(({ z }) => {
      document.querySelector(".map-container")._flightMap.setView([51.5074, -0.1278], z, { animate: false });
    }, { z });
    await page.waitForTimeout(700);
  }
  phases.zoom = { ...(await read()), ...(await frames()) };

  await context.close();
  const row = (phase) => {
    const p = phases[phase];
    const perCall = p.render.calls ? p.render.totalMs / p.render.calls : 0;
    const dPerCall = p.declutter.calls ? p.declutter.totalMs / p.declutter.calls : 0;
    return {
      n,
      phase,
      calls: p.render.calls,
      msPerCall: Number(perCall.toFixed(2)),
      declutterMsPerCall: Number(dPerCall.toFixed(2)),
      declutterShare: perCall ? Number((100 * dPerCall / perCall).toFixed(1)) : 0,
      maxMs: Number(p.render.maxMs.toFixed(2)),
      setData: p.setData.planes + p.setData.selected,
      shadowedMs: Number(p.parts.shadowed.toFixed(1)),
      projectMs: Number(p.parts.project.toFixed(1)),
      updateMs: Number(p.parts.update.toFixed(1)),
      filterMs: Number(p.parts.filter.toFixed(1)),
      drawn: p.drawn,
      frames: p.frames,
      dropped: p.dropped,
      medianFrameMs: p.median,
    };
  };
  return [row("idle"), row("pan"), row("zoom")];
}

const browser = await chromium.launch({
  executablePath: process.env.PW_CHROMIUM_PATH || undefined,
  args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader"],
});
const rows = [];
for (const n of RUNS) {
  try {
    rows.push(...(await run(browser, n)));
    console.error(`done ${n}`);
  } catch (e) {
    console.error(`failed ${n}:`, e.message);
  }
}
await browser.close();
console.table(rows);
console.log(JSON.stringify(rows));
