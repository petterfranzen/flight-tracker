#!/usr/bin/env node
/**
 * Synthetic OpenSky states/all source for the live-feed soak test.
 *
 * Serves the exact JSON shape OpenSkyAgent parses (see
 * backend/.../agent/OpenSkyAgent.java, fetchStates) so the real, unmodified
 * app can be pointed at it with
 *   --flighttracker.agents.opensky.base-url=http://127.0.0.1:<port>
 *
 * It is deliberately deterministic: the same SEED and AIRCRAFT_COUNT give
 * the same world on every run, so a nightly latency number is comparable
 * to yesterday's. Aircraft drift on slow, gentle arcs around a fixed base
 * position; each request stamps time_position/last_contact with "now", so
 * every hot poll produces fresh reports and the app's own persist() path
 * (the one that publishes PositionsPersistedEvent and feeds the WebSocket)
 * runs for real. Nothing is written to the database out of band: the
 * "synthetic DB generator" is this source feeding the app's normal ingest
 * path, which is also how production's first boot is seeded.
 *
 * Routes:
 *   GET /states/all                       worldwide set (global sweep)
 *   GET /states/all?lamin=&lamax=&lomin=&lomax=  bbox-filtered set (hot poll)
 *   GET /stats                            request/state counters for the soak report
 *   GET /health                           liveness for the soak orchestrator
 *
 * Env:
 *   MOCK_PORT         default 18099
 *   MOCK_AIRCRAFT     default 12000   (roughly OpenSky's real worldwide set)
 *   MOCK_SEED         default 42
 *   MOCK_REGION_*     optional viewport override for the *default* region mix
 */

import http from "node:http";

const PORT = Number(process.env.MOCK_PORT || 18099);
const AIRCRAFT = Number(process.env.MOCK_AIRCRAFT || 12000);
const SEED = Number(process.env.MOCK_SEED || 42);

// mulberry32: tiny deterministic PRNG, same one the frontend's 10k fixture uses.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Lumpy distribution, like real traffic: dense Europe, a solid US block,
// an Asia block, and a thin worldwide scatter. Shares sum to 1.
const REGIONS = [
  { id: "europe", share: 0.55, latMin: 35, latMax: 62, lonMin: -12, lonMax: 45 },
  { id: "us", share: 0.20, latMin: 25, latMax: 49, lonMin: -125, lonMax: -70 },
  { id: "asia", share: 0.12, latMin: 5, latMax: 45, lonMin: 65, lonMax: 145 },
  { id: "world", share: 0.13, latMin: -55, latMax: 70, lonMin: -180, lonMax: 180 },
];

const CUMULATIVE = [];
{
  let acc = 0;
  for (const r of REGIONS) {
    acc += r.share;
    CUMULATIVE.push({ ...r, upTo: acc });
  }
}

function regionFor(r) {
  for (const region of CUMULATIVE) if (r <= region.upTo) return region;
  return CUMULATIVE[CUMULATIVE.length - 1];
}

const START = Date.now();
const random = rng(SEED);

// Precompute the world once. Each entry is an aircraft's fixed base point,
// callsign and altitude; position at request time is base + slow drift.
const WORLD = [];
for (let i = 0; i < AIRCRAFT; i++) {
  const region = regionFor(random());
  WORLD.push({
    icao24: i.toString(16).padStart(6, "0"),
    callsign: `SYN${String(i % 9000 + 1000).padStart(4, "0")}`,
    baseLat: region.latMin + random() * (region.latMax - region.latMin),
    baseLon: region.lonMin + random() * (region.lonMax - region.lonMin),
    altitudeM: 8000 + random() * 4000,
    velocityMs: 210 + random() * 50,
    phase: random() * Math.PI * 2,
    verticalRate: (random() - 0.5) * 0.4,
  });
}

const stats = {
  requests: { bbox: 0, global: 0 },
  states: { bbox: 0, global: 0 },
};

const DRIFT_RADIANS_PER_SECOND = (2 * Math.PI) / 600; // one gentle arc per 10 min
const DRIFT_DEGREES = 0.15; // ~17 km radius: visible movement, never leaves its region

function positionAt(a, tSeconds) {
  const theta = DRIFT_RADIANS_PER_SECOND * tSeconds + a.phase;
  const lat = a.baseLat + DRIFT_DEGREES * Math.sin(theta);
  const lon = a.baseLon + DRIFT_DEGREES * Math.cos(theta);
  // Heading from the analytic derivative, in the same convention as OpenSky's true_track.
  const dLat = DRIFT_DEGREES * DRIFT_RADIANS_PER_SECOND * Math.cos(theta);
  const dLon = -DRIFT_DEGREES * DRIFT_RADIANS_PER_SECOND * Math.sin(theta);
  const heading = ((Math.atan2(dLon * Math.cos((lat * Math.PI) / 180), dLat) * 180) / Math.PI + 360) % 360;
  return { lat, lon, heading };
}

// OpenSky state vector layout, indices as OpenSkyAgent reads them:
// 0 icao24, 1 callsign, 2 origin_country, 3 time_position, 4 last_contact,
// 5 lon, 6 lat, 7 baro_altitude, 8 on_ground, 9 velocity, 10 true_track,
// 11 vertical_rate, 12 sensors, 13 geo_altitude, 14 squawk, 15 spi, 16 position_source.
function stateVector(a, tSeconds, nowSeconds) {
  const { lat, lon, heading } = positionAt(a, tSeconds);
  return [
    a.icao24,
    a.callsign,
    "Synthetic",
    nowSeconds,
    nowSeconds,
    lon,
    lat,
    a.altitudeM,
    false,
    a.velocityMs,
    heading,
    a.verticalRate,
    null,
    a.altitudeM,
    "0000",
    false,
    0,
  ];
}

function inBbox(a, tSeconds, b) {
  const { lat, lon } = positionAt(a, tSeconds);
  return lat >= b.latMin && lat <= b.latMax && lon >= b.lonMin && lon <= b.lonMax;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
  if (url.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, aircraft: AIRCRAFT, uptimeSeconds: Math.round((Date.now() - START) / 1000) }));
    return;
  }
  if (url.pathname === "/stats") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      aircraft: AIRCRAFT,
      uptimeSeconds: Math.round((Date.now() - START) / 1000),
      requests: stats.requests,
      states: stats.states,
    }));
    return;
  }
  if (url.pathname !== "/states/all") {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
    return;
  }

  const nowMs = Date.now();
  const nowSeconds = Math.floor(nowMs / 1000);
  const tSeconds = (nowMs - START) / 1000;
  const params = ["lamin", "lamax", "lomin", "lomax"].map((k) => url.searchParams.get(k));

  let states;
  if (params.some((p) => p !== null)) {
    const [lamin, lamax, lomin, lomax] = params.map(Number);
    const b = { latMin: lamin, latMax: lamax, lonMin: lomin, lonMax: lomax };
    states = WORLD.filter((a) => inBbox(a, tSeconds, b)).map((a) => stateVector(a, tSeconds, nowSeconds));
    stats.requests.bbox++;
    stats.states.bbox += states.length;
  } else {
    states = WORLD.map((a) => stateVector(a, tSeconds, nowSeconds));
    stats.requests.global++;
    stats.states.global += states.length;
  }

  const body = JSON.stringify({ time: nowSeconds, states });
  res.writeHead(200, { "content-type": "application/json" });
  res.end(body);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[mock-opensky] listening on 127.0.0.1:${PORT} with ${AIRCRAFT} synthetic aircraft`);
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2_000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
