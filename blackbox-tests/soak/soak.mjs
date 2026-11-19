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

// Modules: config (env settings), servers (mock + jar, sampling), client
// (one WebSocket), histogram, proc (/proc reads), http, processes, report.

import { copyFileSync, existsSync, rmSync } from "node:fs";
import { cfg, log, sleep, stamp } from "./config.mjs";
import { closeAndWait, createClient } from "./client.mjs";
import { LatencyHistogram } from "./histogram.mjs";
import { fetchJson } from "./http.mjs";
import { readCpuSeconds, readRssMb, readVmHwmMb } from "./proc.mjs";
import { stopProcess } from "./processes.mjs";
import { failReport, finishReport, printSummary, report, writeReport } from "./report.mjs";
import { startExternal, startLocal, stopSampling } from "./servers.mjs";

// Everything cleanup() may have to tear down, filled in as the run starts it.
const run = {
  appState: null,
  mockState: null,
  mockUrl: null,
  appLogPath: null,
  tempDir: null,
  sampler: null,
  rssSamples: [],
  clients: [],
};
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

const ignoreErrors = (fn) => {
  try {
    fn();
  } catch {
    /* best effort */
  }
};

function copyAppLog() {
  // Best effort: the report matters more than the log.
  if (run.appLogPath && existsSync(run.appLogPath)) ignoreErrors(() => copyFileSync(run.appLogPath, cfg.appLogOut));
}

async function cleanup() {
  ctx.stopping = true;
  for (const c of run.clients) ignoreErrors(() => c.ws?.close(1000, "soak complete"));
  await sleep(500);
  for (const c of run.clients) ignoreErrors(() => c.ws?.terminate?.());
  stopSampling(run);
  copyAppLog();
  await stopProcess(run.appState, cfg.stopTimeoutSeconds);
  await stopProcess(run.mockState, 5_000);
  if (run.tempDir && !cfg.keepDb) ignoreErrors(() => rmSync(run.tempDir, { recursive: true, force: true }));
}

async function mockStats() {
  if (!run.mockUrl) return null;
  try {
    return (await fetchJson(`${run.mockUrl}/stats`, 3000)).body;
  } catch {
    return null;
  }
}

/** Synthetic-source counters and server RSS/CPU at one edge of the steady window. */
async function snapshot(appPid) {
  const stats = await mockStats();
  const rss = appPid ? readRssMb(appPid) : null;
  const cpu = appPid ? readCpuSeconds(appPid) : null;
  return { stats, rss, cpu };
}

async function connectClients(baseUrl) {
  const wsUrl = baseUrl.replace(/^http/, "ws") + "/ws/live";
  log(`connecting ${cfg.clients} WebSocket clients to ${wsUrl}`);
  for (let i = 0; i < cfg.clients; i++) run.clients.push(createClient(i, wsUrl, ctx));
  await sleep(2000);
  log(`connected=${ctx.connected}/${cfg.clients} clients after 2s`);
}

/** Waits `seconds`, checking every second; onExit runs (and the wait ends) if the app dies. */
async function watchApp(seconds, onExit) {
  const start = Date.now();
  while (Date.now() - start < seconds * 1000) {
    if (run.appState?.exited) {
      onExit();
      break;
    }
    await sleep(1000);
  }
  return start;
}

async function main() {
  log(`mode=${cfg.mode} duration=${cfg.durationSeconds}s clients=${cfg.clients} aircraft=${cfg.aircraft}`);
  log(`viewport ${cfg.view.latMin}..${cfg.view.latMax} N, ${cfg.view.lonMin}..${cfg.view.lonMax} E`);
  const { baseUrl, appPid } = cfg.mode === "local" ? await startLocal(run) : await startExternal();
  await connectClients(baseUrl);

  // Warm-up: let connections settle and let any startup burst clear.
  const warmupStart = await watchApp(cfg.warmupSeconds, () => {});
  ctx.inWarmup = false;
  const start = await snapshot(appPid);
  log(`warm-up complete; steady-state measurement begins (${cfg.durationSeconds}s)`);

  const steadyStart = await watchApp(cfg.durationSeconds, () => {
    report.failures.push(`app process exited during the run (code=${run.appState.exitCode}, signal=${run.appState.signal})`);
  });
  const steadyElapsed = (Date.now() - steadyStart) / 1000;
  const end = await snapshot(appPid);

  // Stop clients cleanly and wait for the close handshake, then stop the app.
  ctx.stopping = true;
  await Promise.all(run.clients.map(closeAndWait));

  finishReport({
    ctx,
    clients: run.clients,
    appState: run.appState,
    appPid,
    peakVmHwm: appPid ? readVmHwmMb(appPid) : null,
    rssSamples: run.rssSamples,
    start,
    end,
    steadyElapsed,
  });
  report.durationSeconds = Math.round(((Date.now() - warmupStart) / 1000) * 10) / 10;
  writeReport();
  printSummary(steadyElapsed);

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
    failReport(`interrupted by ${sig}`);
    ignoreErrors(writeReport);
    await cleanup();
    process.exit(130);
  });
}

main().catch(async (err) => {
  console.error(`[soak] fatal: ${err.stack || err}`);
  failReport(String(err.message || err));
  report.finishedAt = stamp();
  ignoreErrors(writeReport);
  if (run.appState?.lastLines?.length) {
    console.error("[soak] last app log lines:");
    for (const line of run.appState.lastLines.slice(-40)) console.error("  " + line);
  }
  await cleanup();
  process.exit(1);
});
