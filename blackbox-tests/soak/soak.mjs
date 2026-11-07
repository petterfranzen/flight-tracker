#!/usr/bin/env node
/**
 * Production-size soak and load test for the live WebSocket feed.
 *
 * Not part of the PR gate. Run nightly or by hand; it is deliberately long
 * and CPU-hungry (the point is to fill an idle box and find the feed's real
 * behaviour at production scale).
 *
 * What it does
 * ------------
 * 1. Starts the synthetic OpenSky source (mock-opensky.mjs) and the real,
 *    unmodified flight-tracker jar, pointed at that source. The jar's own
 *    empty-DB seed runs a global sweep, so the "synthetic database" is built
 *    through the app's normal ingest path — nothing writes SQLite behind the
 *    app's back. See the README's "Why the generator is the DB generator".
 * 2. Opens the hot-poll window and reports one viewport via GET /api/flights/live,
 *    exactly as the map does. The viewport defaults to a dense, realistic
 *    continent-scale box (10x15 degrees, ~600-800 aircraft in view).
 * 3. Connects N real WebSocket clients to /ws/live. Each parses every frame it
 *    receives, measures the frame's age (now - observedAt, i.e. end-to-end
 *    freshness through poll -> persist -> commit -> broadcast -> socket), and
 *    records frame gaps and close codes.
 * 4. Samples the JVM's RSS and CPU from /proc/PID/{status,stat} while it runs.
 * 5. Writes a JSON report (latency percentiles, memory peak/growth, frame and
 *    delivery counts, close codes) and prints a short summary.
 *
 * Latency note: LiveFrame deliberately has no server-send timestamp (the wire
 * format is frozen), so "frame latency" here is the frame's age at the client:
 * when the aircraft's position was observed upstream to when the client parsed
 * it. In local mode the synthetic source stamps observedAt=now, so the age is
 * almost entirely this app's own poll -> persist -> broadcast path. In external
 * mode it also includes upstream staleness (real OpenSky's last_contact).
 *
 * Usage: see README.md. Quick smoke:
 *   SOAK_DURATION_SECONDS=90 SOAK_WARMUP_SECONDS=20 SOAK_AIRCRAFT=2000 \
 *   SOAK_CLIENTS=10 SOAK_POLL_SECONDS=2 node blackbox-tests/soak/soak.mjs
 */

import { spawn } from "node:child_process";
import { copyFileSync, createWriteStream, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Resolve repo-relative defaults (the jar) against the repo root, not the
// caller's cwd, so `node blackbox-tests/soak/soak.mjs` and running from inside
// the soak directory both find the same jar.
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..");
const resolveRepo = (p) => (path.isAbsolute(p) ? p : path.resolve(REPO_ROOT, p));

// ---------------------------------------------------------------- config

const num = (name, fallback) => {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    console.error(`${name} must be a number, got ${JSON.stringify(raw)}`);
    process.exit(2);
  }
  return n;
};
const str = (name, fallback) => {
  const raw = process.env[name];
  return raw === undefined || raw.trim() === "" ? fallback : raw.trim();
};

const cfg = {
  mode: str("SOAK_MODE", "local"), // local: spawn jar + mock; external: clients only
  baseUrl: str("SOAK_BASE_URL", "http://127.0.0.1:18080").replace(/\/+$/, ""),
  jar: str("SOAK_JAR", "backend/target/flight-tracker.jar"),
  port: num("SOAK_PORT", 18080),
  mockPort: num("SOAK_MOCK_PORT", 18099),
  aircraft: num("SOAK_AIRCRAFT", 12000),
  clients: num("SOAK_CLIENTS", 100),
  pollSeconds: num("SOAK_POLL_SECONDS", 18),
  globalSweepSeconds: num("SOAK_GLOBAL_SWEEP_SECONDS", 360),
  durationSeconds: num("SOAK_DURATION_SECONDS", 900),
  warmupSeconds: num("SOAK_WARMUP_SECONDS", 90),
  startTimeoutSeconds: num("SOAK_START_TIMEOUT_SECONDS", 300),
  stopTimeoutSeconds: num("SOAK_STOP_TIMEOUT_SECONDS", 25),
  rssSampleMs: num("SOAK_RSS_SAMPLE_MS", 5000),
  view: {
    latMin: num("SOAK_VIEW_LAT_MIN", 45),
    latMax: num("SOAK_VIEW_LAT_MAX", 55),
    lonMin: num("SOAK_VIEW_LON_MIN", 5),
    lonMax: num("SOAK_VIEW_LON_MAX", 20),
  },
  java: str("SOAK_JAVA", process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, "bin", "java") : "java"),
  xmx: str("SOAK_XMX", "1g"),
  maxP95Ms: num("SOAK_MAX_P95_MS", 0),
  maxRssMb: num("SOAK_MAX_RSS_MB", 0),
  minDeliveryRatio: num("SOAK_MIN_DELIVERY_RATIO", 0),
  keepDb: str("SOAK_KEEP_DB", "0") === "1",
  out: str("SOAK_OUT", "soak-report.json"),
  appLogOut: str("SOAK_APP_LOG", "soak-app.log"),
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString();
const log = (...a) => console.log(`[soak ${stamp()}]`, ...a);

// ------------------------------------------------------------ histogram

/** 1 ms buckets up to maxBucketMs, plus an overflow counter. ~1.2 MB at 300 s. */
class LatencyHistogram {
  constructor(maxBucketMs = 300_000) {
    this.buckets = new Uint32Array(maxBucketMs + 1);
    this.overflow = 0;
    this.count = 0;
    this.sum = 0;
    this.max = 0;
  }

  add(ms) {
    if (!Number.isFinite(ms) || ms < 0) return;
    if (ms >= this.buckets.length) this.overflow++;
    else this.buckets[Math.floor(ms)]++;
    this.count++;
    this.sum += ms;
    if (ms > this.max) this.max = ms;
  }

  percentile(p) {
    if (this.count === 0) return null;
    const target = Math.ceil(this.count * p);
    let seen = 0;
    for (let i = 0; i < this.buckets.length; i++) {
      seen += this.buckets[i];
      if (seen >= target) return i;
    }
    return this.buckets.length; // in the overflow bucket
  }

  summary() {
    if (this.count === 0) return { count: 0 };
    return {
      count: this.count,
      meanMs: Math.round((this.sum / this.count) * 10) / 10,
      p50Ms: this.percentile(0.5),
      p95Ms: this.percentile(0.95),
      p99Ms: this.percentile(0.99),
      p999Ms: this.percentile(0.999),
      maxMs: Math.round(this.max * 10) / 10,
      overflow: this.overflow,
    };
  }
}

// --------------------------------------------------------- /proc reading

function readProc(pid, file) {
  try {
    return readFileSync(`/proc/${pid}/${file}`, "utf8");
  } catch {
    return null;
  }
}

function readRssMb(pid) {
  const status = readProc(pid, "status");
  if (!status) return null;
  const m = status.match(/^VmRSS:\s+(\d+)\s+kB/m);
  return m ? Math.round((Number(m[1]) / 1024) * 10) / 10 : null;
}

function readVmHwmMb(pid) {
  const status = readProc(pid, "status");
  if (!status) return null;
  const m = status.match(/^VmHWM:\s+(\d+)\s+kB/m);
  return m ? Math.round((Number(m[1]) / 1024) * 10) / 10 : null;
}

/** utime+stime in seconds. /proc/PID/stat fields are 1-indexed; after ")" state is field 3. */
function readCpuSeconds(pid) {
  const stat = readProc(pid, "stat");
  if (!stat) return null;
  const close = stat.lastIndexOf(")");
  if (close < 0) return null;
  const fields = stat.slice(close + 2).split(" ");
  const ticks = Number(fields[11]) + Number(fields[12]); // utime, stime
  return Number.isFinite(ticks) ? Math.round((ticks / 100) * 100) / 100 : null; // CLK_TCK=100 on Linux
}

// ------------------------------------------------------------ HTTP utils

async function fetchJson(url, timeoutMs = 3000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    const text = await res.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

async function waitFor(url, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const { status } = await fetchJson(url, 3000);
      if (status >= 200 && status < 300) return;
      last = `HTTP ${status}`;
    } catch (e) {
      last = e.name === "AbortError" ? "timeout" : e.message;
    }
    await sleep(1000);
  }
  throw new Error(`${label} did not become ready within ${timeoutMs}ms (last: ${last})`);
}

// ---------------------------------------------------------------- process

function startProcess(name, command, args, opts = {}) {
  const child = spawn(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
    ...opts,
  });
  const state = { name, child, exitCode: null, signal: null, exited: false, lastLines: [] };
  const keep = (chunk) => {
    for (const line of chunk.toString().split("\n")) {
      if (!line.trim()) continue;
      state.lastLines.push(line);
      if (state.lastLines.length > 80) state.lastLines.shift();
    }
  };
  child.stdout?.on("data", keep);
  child.stderr?.on("data", keep);
  child.on("exit", (code, signal) => {
    state.exitCode = code;
    state.signal = signal;
    state.exited = true;
  });
  child.on("error", (err) => {
    state.spawnError = err.message;
    state.exited = true;
    keep(Buffer.from(`${name}: failed to start: ${err.message}`));
  });
  return state;
}

async function stopProcess(state, timeoutMs) {
  if (!state || state.exited) return;
  try {
    state.child.kill("SIGTERM");
  } catch {
    /* already gone */
  }
  const deadline = Date.now() + timeoutMs;
  while (!state.exited && Date.now() < deadline) await sleep(200);
  if (!state.exited) {
    try {
      state.child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
    await sleep(500);
  }
}

// ---------------------------------------------------------------- clients

function createClient(id, wsUrl, ctx) {
  const c = {
    id,
    ws: null,
    frames: 0,
    malformed: 0,
    reconnects: 0,
    dead: false,
    closes: {},
    firstFrameAt: null,
    lastFrameAt: null,
    lastArrivalMs: null,
    gapCount: 0,
    gapSumMs: 0,
    gapMaxMs: 0,
  };

  const connect = () => {
    if (ctx.stopping || c.dead) return;
    let ws;
    try {
      ws = new WebSocket(wsUrl);
    } catch (e) {
      c.closes["connect-error"] = (c.closes["connect-error"] || 0) + 1;
      scheduleReconnect();
      return;
    }
    c.ws = ws;

    ws.addEventListener("open", () => {
      ctx.connected++;
    });

    ws.addEventListener("message", (event) => {
      if (ctx.stopping) return;
      const now = Date.now();
      c.frames++;
      ctx.framesTotal++;
      if (c.firstFrameAt === null) c.firstFrameAt = now;

      let frame = null;
      try {
        frame = JSON.parse(typeof event.data === "string" ? event.data : event.data.toString());
      } catch {
        c.malformed++;
        ctx.malformedTotal++;
        return;
      }
      const observed = Date.parse(frame.observedAt);
      if (Number.isNaN(observed)) {
        c.malformed++;
        ctx.malformedTotal++;
        return;
      }
      const age = now - observed;

      if (ctx.inWarmup) {
        ctx.warmupFrames++;
      } else {
        ctx.steadyFrames++;
        ctx.latency.add(age);
        if (c.lastArrivalMs !== null) {
          const gap = now - c.lastArrivalMs;
          c.gapCount++;
          c.gapSumMs += gap;
          if (gap > c.gapMaxMs) c.gapMaxMs = gap;
        }
      }
      c.lastArrivalMs = now;
      c.lastFrameAt = now;
    });

    ws.addEventListener("close", (event) => {
      const code = event.code || 0;
      c.closes[code] = (c.closes[code] || 0) + 1;
      // Close codes seen while we are deliberately tearing down are harness
      // noise (a half-finished close handshake reports 1006). Only closes
      // that happen while the run is live say anything about the server.
      if (ctx.stopping) ctx.closesAtShutdown++;
      else ctx.closeCodes[code] = (ctx.closeCodes[code] || 0) + 1;
      c.ws = null;
      if (!ctx.stopping) scheduleReconnect();
    });

    ws.addEventListener("error", () => {
      c.closes["error"] = (c.closes["error"] || 0) + 1;
    });
  };

  const scheduleReconnect = () => {
    if (ctx.stopping || c.dead) return;
    c.reconnects++;
    if (c.reconnects > 20) {
      c.dead = true;
      ctx.deadClients++;
      return;
    }
    const delay = Math.min(250 * 2 ** Math.min(c.reconnects - 1, 5), 10_000);
    setTimeout(connect, delay);
  };

  connect();
  return c;
}

// --------------------------------------------------------------- the run

const report = {
  tool: "flight-tracker live-feed soak",
  startedAt: stamp(),
  mode: cfg.mode,
  config: cfg,
  server: null,
  clients: null,
  frames: null,
  latency: null,
  delivery: null,
  warnings: [],
  failures: [],
};

let appState = null;
let mockState = null;
let mockUrl = null;
let clients = [];
let appLogPath = null;
let tempDir = null;
let sampler = null;
const rssSamples = [];
const ctx = {
  stopping: false,
  inWarmup: true,
  latency: new LatencyHistogram(),
  framesTotal: 0,
  steadyFrames: 0,
  warmupFrames: 0,
  malformedTotal: 0,
  connected: 0,
  deadClients: 0,
  closeCodes: {},
  closesAtShutdown: 0,
};

function beginSampling(pid) {
  const sample = () => {
    if (!pid) return;
    const rss = readRssMb(pid);
    if (rss !== null) rssSamples.push({ at: stamp(), rssMb: rss, cpuSeconds: readCpuSeconds(pid) });
  };
  sample();
  sampler = setInterval(sample, cfg.rssSampleMs);
  sampler.unref?.();
}

function stopSampling() {
  if (sampler) clearInterval(sampler);
  sampler = null;
}

async function cleanup() {
  ctx.stopping = true;
  for (const c of clients) {
    try {
      c.ws?.close(1000, "soak complete");
    } catch {
      /* already closed */
    }
  }
  await sleep(500);
  for (const c of clients) {
    try {
      c.ws?.terminate?.();
    } catch {
      /* ignore */
    }
  }
  stopSampling();
  if (appLogPath && existsSync(appLogPath)) {
    try {
      copyFileSync(appLogPath, cfg.appLogOut);
    } catch {
      /* best effort: the report matters more than the log */
    }
  }
  await stopProcess(appState, cfg.stopTimeoutSeconds);
  await stopProcess(mockState, 5_000);
  if (tempDir && !cfg.keepDb) {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

async function main() {
  log(`mode=${cfg.mode} duration=${cfg.durationSeconds}s clients=${cfg.clients} aircraft=${cfg.aircraft}`);
  log(`viewport ${cfg.view.latMin}..${cfg.view.latMax} N, ${cfg.view.lonMin}..${cfg.view.lonMax} E`);

  let baseUrl = cfg.baseUrl;
  let appPid = null;

  if (cfg.mode === "local") {
    tempDir = mkdtempSync(path.join(tmpdir(), "ft-soak-"));
    appLogPath = path.join(tempDir, "app.log");

    mockUrl = `http://127.0.0.1:${cfg.mockPort}`;
    log(`starting synthetic OpenSky on ${mockUrl} (${cfg.aircraft} aircraft)`);
    mockState = startProcess("mock-opensky", process.execPath, [
      path.join(SCRIPT_DIR, "mock-opensky.mjs"),
    ], {
      env: { ...process.env, MOCK_PORT: String(cfg.mockPort), MOCK_AIRCRAFT: String(cfg.aircraft) },
    });
    await waitFor(`${mockUrl}/health`, 30_000, "synthetic OpenSky");

    const jar = resolveRepo(cfg.jar);
    try {
      readFileSync(jar); // exists and readable
    } catch {
      throw new Error(`jar not found at ${jar}. Build it first: (cd backend && mvn -B package -DskipTests)`);
    }

    baseUrl = `http://127.0.0.1:${cfg.port}`;
    const dbPath = path.join(tempDir, "flighttracker.db");
    const appLog = createWriteStream(appLogPath);
    const args = [
      `-Xmx${cfg.xmx}`,
      "-XX:+ExitOnOutOfMemoryError",
      "-jar", jar,
      `--server.port=${cfg.port}`,
      "--server.address=127.0.0.1",
      `--flighttracker.db-path=${dbPath}`,
      `--flighttracker.agents.opensky.base-url=${mockUrl}`,
      `--flighttracker.agents.poll-interval-seconds=${cfg.pollSeconds}`,
      `--flighttracker.agents.global-sweep-interval-seconds=${cfg.globalSweepSeconds}`,
      "--flighttracker.agents.poll-window-seconds=86400",
      "--flighttracker.agents.hot-poll-daily-call-budget=100000000",
      "--flighttracker.agents.restart-quota-max=1000000",
      "--flighttracker.rate-limit.trust-local=true",
      "--flighttracker.confirmation.mock.enabled=false",
      "--spring.main.banner-mode=off",
    ];
    log(`starting jar on ${baseUrl} (db ${dbPath}, -Xmx${cfg.xmx})`);
    appState = startProcess("flight-tracker", cfg.java, args, { cwd: REPO_ROOT });
    appState.child.stdout?.pipe(appLog);
    appState.child.stderr?.pipe(appLog);

    // An empty DB runs a full global sweep inside @PostConstruct, so health
    // only answers after ~aircraft-count rows have been ingested. That is the
    // production first-boot path; give it room.
    if (appState.exited) {
      throw new Error(`the jar failed to start (${appState.spawnError || `exit ${appState.exitCode}`}). ` +
        `Set SOAK_JAVA to a Java 21 binary if "java" is not on PATH.`);
    }
    await waitFor(`${baseUrl}/api/health`, cfg.startTimeoutSeconds * 1000, "flight-tracker /api/health");
    appPid = appState.child.pid;
    beginSampling(appPid);

    // Reopen the poll window and report the viewport exactly as the map does.
    await fetchJson(`${baseUrl}/api/agents/restart`, 5000);
    const v = cfg.view;
    const live = await fetchJson(
      `${baseUrl}/api/flights/live?latMin=${v.latMin}&latMax=${v.latMax}&lonMin=${v.lonMin}&lonMax=${v.lonMax}`,
      60_000,
    );
    log(`viewport reported; /api/flights/live returned HTTP ${live.status} (${Array.isArray(live.body) ? live.body.length : "?"} markers)`);
  } else {
    log(`external mode: load clients only against ${baseUrl} (server memory is not sampled)`);
    await waitFor(`${baseUrl}/api/health`, 60_000, "external /api/health");
    const v = cfg.view;
    await fetchJson(`${baseUrl}/api/flights/live?latMin=${v.latMin}&latMax=${v.latMax}&lonMin=${v.lonMin}&lonMax=${v.lonMax}`, 60_000);
  }

  const wsUrl = baseUrl.replace(/^http/, "ws") + "/ws/live";
  log(`connecting ${cfg.clients} WebSocket clients to ${wsUrl}`);
  for (let i = 0; i < cfg.clients; i++) clients.push(createClient(i, wsUrl, ctx));
  await sleep(2000);
  log(`connected=${ctx.connected}/${cfg.clients} clients after 2s`);

  const mockStats = async () => {
    if (!mockUrl) return null;
    try {
      return (await fetchJson(`${mockUrl}/stats`, 3000)).body;
    } catch {
      return null;
    }
  };

  // Warm-up: let connections settle and let any startup burst clear.
  const warmupStart = Date.now();
  while (Date.now() - warmupStart < cfg.warmupSeconds * 1000) {
    if (appState?.exited) break;
    await sleep(1000);
  }
  ctx.inWarmup = false;
  const statsAtSteadyStart = await mockStats();
  const rssAtSteadyStart = appPid ? readRssMb(appPid) : null;
  const cpuAtSteadyStart = appPid ? readCpuSeconds(appPid) : null;
  log(`warm-up complete; steady-state measurement begins (${cfg.durationSeconds}s)`);

  // Steady state.
  const steadyStart = Date.now();
  while (Date.now() - steadyStart < cfg.durationSeconds * 1000) {
    if (appState?.exited) {
      report.failures.push(`app process exited during the run (code=${appState.exitCode}, signal=${appState.signal})`);
      break;
    }
    await sleep(1000);
  }
  const steadyElapsed = (Date.now() - steadyStart) / 1000;

  const statsAtSteadyEnd = await mockStats();
  const rssAtSteadyEnd = appPid ? readRssMb(appPid) : null;
  const cpuAtSteadyEnd = appPid ? readCpuSeconds(appPid) : null;

  // Stop clients cleanly and wait for the close handshake, then stop the app.
  ctx.stopping = true;
  await Promise.all(clients.map((c) => new Promise((resolve) => {
    const ws = c.ws;
    if (!ws || ws.readyState === WebSocket.CLOSED) return resolve();
    const done = () => resolve();
    ws.addEventListener("close", done, { once: true });
    try {
      ws.close(1000, "soak complete");
    } catch {
      return resolve();
    }
    setTimeout(done, 3000);
  })));

  const rssValues = rssSamples.map((s) => s.rssMb);
  if (rssAtSteadyEnd !== null) rssValues.push(rssAtSteadyEnd);
  const peakRss = rssValues.length ? Math.max(...rssValues) : null;
  const minRss = rssValues.length ? Math.min(...rssValues) : null;

  report.finishedAt = stamp();
  report.server = {
    mode: cfg.mode,
    pid: appPid,
    alive: appState ? !appState.exited : null,
    exitCode: appState?.exitCode ?? null,
    rssMb: {
      atSteadyStart: rssAtSteadyStart,
      atSteadyEnd: rssAtSteadyEnd,
      min: minRss,
      peak: peakRss,
      peakVmHwm: appPid ? readVmHwmMb(appPid) : null,
      growthMb: rssAtSteadyStart !== null && rssAtSteadyEnd !== null ? Math.round((rssAtSteadyEnd - rssAtSteadyStart) * 10) / 10 : null,
    },
    cpuSeconds: {
      atSteadyStart: cpuAtSteadyStart,
      atSteadyEnd: cpuAtSteadyEnd,
      used: cpuAtSteadyStart !== null && cpuAtSteadyEnd !== null ? Math.round((cpuAtSteadyEnd - cpuAtSteadyStart) * 100) / 100 : null,
    },
    samples: rssSamples.length,
  };

  report.clients = {
    configured: cfg.clients,
    connectedAfter2s: ctx.connected,
    dead: ctx.deadClients,
    reconnects: clients.reduce((n, c) => n + c.reconnects, 0),
    closeCodes: ctx.closeCodes,
    closesAtShutdown: ctx.closesAtShutdown,
    received: clients.map((c) => c.frames),
  };

  const received = clients.map((c) => c.frames);
  received.sort((a, b) => a - b);
  const median = received.length ? received[Math.floor(received.length / 2)] : 0;
  const totalReceived = received.reduce((a, b) => a + b, 0);

  const bboxStatesAtStart = statsAtSteadyStart?.states?.bbox ?? null;
  const bboxStatesAtEnd = statsAtSteadyEnd?.states?.bbox ?? null;
  const expectedPerClient = bboxStatesAtStart !== null && bboxStatesAtEnd !== null ? bboxStatesAtEnd - bboxStatesAtStart : null;
  // ctx.steadyFrames is the sum across clients of frames parsed during the
  // steady window; every connected client receives every broadcast (one shared
  // viewport), so expected per client is the synthetic state count itself.
  const ratio = expectedPerClient && expectedPerClient > 0 && cfg.clients > 0 ? ctx.steadyFrames / (expectedPerClient * cfg.clients) : null;

  report.frames = {
    totalReceived,
    steady: ctx.steadyFrames,
    warmup: ctx.warmupFrames,
    malformed: ctx.malformedTotal,
    perSecondSteady: steadyElapsed > 0 ? Math.round((ctx.steadyFrames / steadyElapsed) * 10) / 10 : null,
    perClient: {
      min: received.length ? received[0] : null,
      median,
      max: received.length ? received[received.length - 1] : null,
    },
  };
  report.latency = ctx.latency.summary();
  report.delivery = {
    syntheticStatesInBboxDuringSteady: expectedPerClient,
    perClientExpected: expectedPerClient,
    ratio: ratio === null ? null : Math.round(ratio * 1000) / 1000,
    note: "ratio = steady frames parsed by all clients / (synthetic states returned in bbox during steady state x clients); a value near 1.0 means every broadcast reached every client, below ~0.9 means frames were dropped or clients fell behind",
  };

  // Client gap stats: the delivery cadence each client actually saw.
  const gaps = clients
    .filter((c) => c.gapCount > 0)
    .map((c) => ({ mean: c.gapSumMs / c.gapCount, max: c.gapMaxMs }));
  report.clients.gapMs = gaps.length
    ? {
        mean: Math.round((gaps.reduce((n, g) => n + g.mean, 0) / gaps.length) * 10) / 10,
        max: Math.max(...gaps.map((g) => g.max)),
      }
    : null;

  if (ctx.connected === 0) report.failures.push("no WebSocket client connected");
  if (ctx.steadyFrames === 0) report.failures.push("no frames received during steady state");
  if (cfg.maxP95Ms > 0 && report.latency.p95Ms > cfg.maxP95Ms) {
    report.failures.push(`p95 latency ${report.latency.p95Ms}ms exceeded SOAK_MAX_P95_MS=${cfg.maxP95Ms}`);
  }
  if (cfg.maxRssMb > 0 && peakRss !== null && peakRss > cfg.maxRssMb) {
    report.failures.push(`peak RSS ${peakRss}MB exceeded SOAK_MAX_RSS_MB=${cfg.maxRssMb}`);
  }
  if (cfg.minDeliveryRatio > 0 && ratio !== null && ratio < cfg.minDeliveryRatio) {
    report.failures.push(`delivery ratio ${ratio.toFixed(3)} below SOAK_MIN_DELIVERY_RATIO=${cfg.minDeliveryRatio}`);
  }
  if (ctx.deadClients > 0) report.warnings.push(`${ctx.deadClients} clients gave up after repeated reconnects`);
  if (ctx.malformedTotal > 0) report.warnings.push(`${ctx.malformedTotal} frames failed to parse or had no observedAt`);

  report.ok = report.failures.length === 0;
  report.durationSeconds = Math.round(((Date.now() - warmupStart) / 1000) * 10) / 10;

  writeFileSync(cfg.out, JSON.stringify(report, null, 2));
  log(`report written to ${path.resolve(cfg.out)}`);

  const s = report.latency;
  log("------------------------------------------------------------");
  log(`clients: ${cfg.clients}  steady frames: ${report.frames.steady} (${report.frames.perSecondSteady}/s)`);
  log(`latency: p50=${s.p50Ms}ms p95=${s.p95Ms}ms p99=${s.p99Ms}ms max=${s.maxMs}ms`);
  log(`server RSS: start=${rssAtSteadyStart}MB end=${rssAtSteadyEnd}MB peak=${peakRss}MB growth=${report.server.rssMb.growthMb}MB`);
  log(`server CPU during steady: ${report.server.cpuSeconds.used}s over ${Math.round(steadyElapsed)}s`);
  log(`delivery ratio: ${report.delivery.ratio ?? "n/a"}  close codes: ${JSON.stringify(ctx.closeCodes)}`);
  log(`result: ${report.ok ? "PASS" : "FAIL"}${report.failures.length ? " — " + report.failures.join("; ") : ""}`);
  log("------------------------------------------------------------");

  await cleanup();
  process.exit(report.ok ? 0 : 1);
}

// Ctrl-C / SIGTERM: stop children and still leave a partial report behind.
let signalled = false;
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    if (signalled) process.exit(130);
    signalled = true;
    log(`${sig} received — cleaning up`);
    report.failures.push(`interrupted by ${sig}`);
    report.ok = false;
    try {
      writeFileSync(cfg.out, JSON.stringify(report, null, 2));
    } catch {
      /* ignore */
    }
    await cleanup();
    process.exit(130);
  });
}

main().catch(async (err) => {
  console.error(`[soak] fatal: ${err.stack || err}`);
  report.failures.push(String(err.message || err));
  report.ok = false;
  report.finishedAt = stamp();
  try {
    writeFileSync(cfg.out, JSON.stringify(report, null, 2));
  } catch {
    /* ignore */
  }
  if (appState?.lastLines?.length) {
    console.error("[soak] last app log lines:");
    for (const line of appState.lastLines.slice(-40)) console.error("  " + line);
  }
  await cleanup();
  process.exit(1);
});
