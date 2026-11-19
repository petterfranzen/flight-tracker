// The soak's JSON report: the skeleton written from the start, the sections
// filled in after the steady window, the pass/fail checks and the summary.

import { writeFileSync } from "node:fs";
import path from "node:path";
import { cfg, log, round, stamp } from "./config.mjs";

export const report = {
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

export const writeReport = () => writeFileSync(cfg.out, JSON.stringify(report, null, 2));

/** Records a fatal reason; the report is then not ok. */
export function failReport(reason) {
  report.failures.push(reason);
  report.ok = false;
}

const both = (a, b) => a !== null && b !== null;
const diffOrNull = (a, b, places) => (both(a, b) ? round(b - a, places) : null);

function rssRange(m) {
  const rssValues = m.rssSamples.map((s) => s.rssMb);
  if (m.end.rss !== null) rssValues.push(m.end.rss);
  if (!rssValues.length) return { min: null, peak: null };
  return { min: Math.min(...rssValues), peak: Math.max(...rssValues) };
}

function serverSection(m, range) {
  const { appState, appPid, start, end } = m;
  return {
    mode: cfg.mode,
    pid: appPid,
    alive: appState ? !appState.exited : null,
    exitCode: appState?.exitCode ?? null,
    rssMb: {
      atSteadyStart: start.rss,
      atSteadyEnd: end.rss,
      min: range.min,
      peak: range.peak,
      peakVmHwm: m.peakVmHwm,
      growthMb: diffOrNull(start.rss, end.rss, 1),
    },
    cpuSeconds: {
      atSteadyStart: start.cpu,
      atSteadyEnd: end.cpu,
      used: diffOrNull(start.cpu, end.cpu, 2),
    },
    samples: m.rssSamples.length,
  };
}

function clientsSection(ctx, clients) {
  return {
    configured: cfg.clients,
    connectedAfter2s: ctx.connected,
    dead: ctx.deadClients,
    reconnects: clients.reduce((n, c) => n + c.reconnects, 0),
    closeCodes: ctx.closeCodes,
    closesAtShutdown: ctx.closesAtShutdown,
    received: clients.map((c) => c.frames),
  };
}

function framesSection(ctx, clients, steadyElapsed) {
  const received = clients.map((c) => c.frames);
  received.sort((a, b) => a - b);
  const any = received.length > 0;
  return {
    totalReceived: received.reduce((a, b) => a + b, 0),
    steady: ctx.steadyFrames,
    warmup: ctx.warmupFrames,
    malformed: ctx.malformedTotal,
    perSecondSteady: steadyElapsed > 0 ? round(ctx.steadyFrames / steadyElapsed, 1) : null,
    perClient: {
      min: any ? received[0] : null,
      median: any ? received[Math.floor(received.length / 2)] : 0,
      max: any ? received[received.length - 1] : null,
    },
  };
}

// ctx.steadyFrames is the sum across clients of frames parsed during the
// steady window; every connected client receives every broadcast (one shared
// viewport), so expected per client is the synthetic state count itself.
function deliveryRatio(ctx, expectedPerClient) {
  if (!(expectedPerClient > 0) || !(cfg.clients > 0)) return null;
  return ctx.steadyFrames / (expectedPerClient * cfg.clients);
}

function deliverySection(ctx, start, end) {
  const bboxAtStart = start.stats?.states?.bbox ?? null;
  const bboxAtEnd = end.stats?.states?.bbox ?? null;
  const expectedPerClient = both(bboxAtStart, bboxAtEnd) ? bboxAtEnd - bboxAtStart : null;
  const ratio = deliveryRatio(ctx, expectedPerClient);
  return {
    ratio,
    section: {
      syntheticStatesInBboxDuringSteady: expectedPerClient,
      perClientExpected: expectedPerClient,
      ratio: ratio === null ? null : round(ratio, 3),
      note: "ratio = steady frames parsed by all clients / (synthetic states returned in bbox during steady state x clients); a value near 1.0 means every broadcast reached every client, below ~0.9 means frames were dropped or clients fell behind",
    },
  };
}

// Client gap stats: the delivery cadence each client actually saw.
function gapStats(clients) {
  const gaps = clients
    .filter((c) => c.gapCount > 0)
    .map((c) => ({ mean: c.gapSumMs / c.gapCount, max: c.gapMaxMs }));
  if (!gaps.length) return null;
  return {
    mean: round(gaps.reduce((n, g) => n + g.mean, 0) / gaps.length, 1),
    max: Math.max(...gaps.map((g) => g.max)),
  };
}

function failureChecks(ctx, peakRss, ratio) {
  const p95 = report.latency.p95Ms;
  return [
    [ctx.connected === 0, () => "no WebSocket client connected"],
    [ctx.steadyFrames === 0, () => "no frames received during steady state"],
    [cfg.maxP95Ms > 0 && p95 > cfg.maxP95Ms, () => `p95 latency ${p95}ms exceeded SOAK_MAX_P95_MS=${cfg.maxP95Ms}`],
    [cfg.maxRssMb > 0 && peakRss !== null && peakRss > cfg.maxRssMb,
      () => `peak RSS ${peakRss}MB exceeded SOAK_MAX_RSS_MB=${cfg.maxRssMb}`],
    [cfg.minDeliveryRatio > 0 && ratio !== null && ratio < cfg.minDeliveryRatio,
      () => `delivery ratio ${ratio.toFixed(3)} below SOAK_MIN_DELIVERY_RATIO=${cfg.minDeliveryRatio}`],
  ];
}

function warningChecks(ctx) {
  return [
    [ctx.deadClients > 0, () => `${ctx.deadClients} clients gave up after repeated reconnects`],
    [ctx.malformedTotal > 0, () => `${ctx.malformedTotal} frames failed to parse or had no observedAt`],
  ];
}

const pushHits = (list, checks) => {
  for (const [hit, message] of checks) if (hit) list.push(message());
};

/**
 * Fills the report from the run's measurements `m`: { ctx, clients, appState,
 * appPid, peakVmHwm, rssSamples, start, end, steadyElapsed }, where start and
 * end are { stats, rss, cpu } at the edges of the steady window.
 */
export function finishReport(m) {
  const { ctx, clients } = m;
  const range = rssRange(m);
  report.finishedAt = stamp();
  report.server = serverSection(m, range);
  report.clients = clientsSection(ctx, clients);
  report.frames = framesSection(ctx, clients, m.steadyElapsed);
  report.latency = ctx.latency.summary();
  const delivery = deliverySection(ctx, m.start, m.end);
  report.delivery = delivery.section;
  report.clients.gapMs = gapStats(clients);
  pushHits(report.failures, failureChecks(ctx, range.peak, delivery.ratio));
  pushHits(report.warnings, warningChecks(ctx));
  report.ok = report.failures.length === 0;
}

export function printSummary(steadyElapsed) {
  const s = report.latency;
  const rss = report.server.rssMb;
  log(`report written to ${path.resolve(cfg.out)}`);
  log("------------------------------------------------------------");
  log(`clients: ${cfg.clients}  steady frames: ${report.frames.steady} (${report.frames.perSecondSteady}/s)`);
  log(`latency: p50=${s.p50Ms}ms p95=${s.p95Ms}ms p99=${s.p99Ms}ms max=${s.maxMs}ms`);
  log(`server RSS: start=${rss.atSteadyStart}MB end=${rss.atSteadyEnd}MB peak=${rss.peak}MB growth=${rss.growthMb}MB`);
  log(`server CPU during steady: ${report.server.cpuSeconds.used}s over ${Math.round(steadyElapsed)}s`);
  log(`delivery ratio: ${report.delivery.ratio ?? "n/a"}  close codes: ${JSON.stringify(report.clients.closeCodes)}`);
  log(`result: ${report.ok ? "PASS" : "FAIL"}${report.failures.length ? " — " + report.failures.join("; ") : ""}`);
  log("------------------------------------------------------------");
}
