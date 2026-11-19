// Bringing up what the clients connect to: in local mode the synthetic
// OpenSky source and the real jar (with RSS/CPU sampling); in external mode
// just a health wait on SOAK_BASE_URL. Both then report the viewport.

import { createWriteStream, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { REPO_ROOT, SCRIPT_DIR, cfg, log, resolveRepo, stamp, viewQuery } from "./config.mjs";
import { fetchJson, isOk, waitFor } from "./http.mjs";
import { readCpuSeconds, readRssMb } from "./proc.mjs";
import { startProcess } from "./processes.mjs";

function jarArgs(jar, dbPath, mockUrl) {
  return [
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
}

async function startMock(run) {
  run.mockUrl = `http://127.0.0.1:${cfg.mockPort}`;
  log(`starting synthetic OpenSky on ${run.mockUrl} (${cfg.aircraft} aircraft)`);
  run.mockState = startProcess("mock-opensky", process.execPath, [
    path.join(SCRIPT_DIR, "mock-opensky.mjs"),
  ], {
    env: { ...process.env, MOCK_PORT: String(cfg.mockPort), MOCK_AIRCRAFT: String(cfg.aircraft) },
  });
  await waitFor(`${run.mockUrl}/health`, 30_000, "synthetic OpenSky");
}

function requireJar() {
  const jar = resolveRepo(cfg.jar);
  try {
    readFileSync(jar); // exists and readable
  } catch {
    throw new Error(`jar not found at ${jar}. Build it first: (cd backend && mvn -B package -DskipTests)`);
  }
  return jar;
}

function startJar(run, jar, baseUrl) {
  const dbPath = path.join(run.tempDir, "flighttracker.db");
  const appLog = createWriteStream(run.appLogPath);
  log(`starting jar on ${baseUrl} (db ${dbPath}, -Xmx${cfg.xmx})`);
  run.appState = startProcess("flight-tracker", cfg.java, jarArgs(jar, dbPath, run.mockUrl), { cwd: REPO_ROOT });
  run.appState.child.stdout?.pipe(appLog);
  run.appState.child.stderr?.pipe(appLog);
  // An empty DB runs a full global sweep inside @PostConstruct, so health
  // only answers after ~aircraft-count rows have been ingested. That is the
  // production first-boot path; give it room.
  if (run.appState.exited) {
    const { spawnError, exitCode } = run.appState;
    throw new Error(`the jar failed to start (${spawnError || `exit ${exitCode}`}). ` +
      `Set SOAK_JAVA to a Java 21 binary if "java" is not on PATH.`);
  }
}

function beginSampling(run, pid) {
  const sample = () => {
    if (!pid) return;
    const rss = readRssMb(pid);
    if (rss !== null) run.rssSamples.push({ at: stamp(), rssMb: rss, cpuSeconds: readCpuSeconds(pid) });
  };
  sample();
  run.sampler = setInterval(sample, cfg.rssSampleMs);
  run.sampler.unref?.();
}

export function stopSampling(run) {
  if (run.sampler) clearInterval(run.sampler);
  run.sampler = null;
}

// Reopen the poll window and report the viewport exactly as the map does.
// The endpoint is POST-only (GET is 405), so the restart must send POST.
async function openPollWindow(baseUrl) {
  const restart = await fetchJson(`${baseUrl}/api/agents/restart`, 5000, { method: "POST" });
  if (!isOk(restart.status)) {
    throw new Error(`POST /api/agents/restart returned HTTP ${restart.status}; the poll window never reopened`);
  }
  log(`poll window reopened via POST /api/agents/restart (HTTP ${restart.status})`);
  const live = await fetchJson(`${baseUrl}/api/flights/live?${viewQuery(cfg.view)}`, 60_000);
  const markers = Array.isArray(live.body) ? live.body.length : "?";
  log(`viewport reported; /api/flights/live returned HTTP ${live.status} (${markers} markers)`);
}

/** Local mode: mock + jar on loopback. Returns { baseUrl, appPid }. */
export async function startLocal(run) {
  run.tempDir = mkdtempSync(path.join(tmpdir(), "ft-soak-"));
  run.appLogPath = path.join(run.tempDir, "app.log");
  await startMock(run);
  const jar = requireJar();
  const baseUrl = `http://127.0.0.1:${cfg.port}`;
  startJar(run, jar, baseUrl);
  await waitFor(`${baseUrl}/api/health`, cfg.startTimeoutSeconds * 1000, "flight-tracker /api/health");
  const appPid = run.appState.child.pid;
  beginSampling(run, appPid);
  await openPollWindow(baseUrl);
  return { baseUrl, appPid };
}

/** External mode: clients only, against SOAK_BASE_URL. */
export async function startExternal() {
  const baseUrl = cfg.baseUrl;
  log(`external mode: load clients only against ${baseUrl} (server memory is not sampled)`);
  await waitFor(`${baseUrl}/api/health`, 60_000, "external /api/health");
  await fetchJson(`${baseUrl}/api/flights/live?${viewQuery(cfg.view)}`, 60_000);
  return { baseUrl, appPid: null };
}
