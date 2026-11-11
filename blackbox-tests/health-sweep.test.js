// Pins the health contract the cloud migration added (PLAN.md §6 item 11):
// the extra fields on GET /api/health and the separate GET /api/health/sweep
// check. Nothing here reaches OpenSky, and an unreachable OpenSky is a legal
// state — the sweep simply writes no rows — so the test asserts whatever the
// jar's real state is, and, above all, that the two endpoints agree with each
// other. That agreement is the contract a later change could silently break.
//
// A note on the swept-freshness fields: `lastSweepAt` advances only on a global
// sweep that actually wrote rows, so it is null until the first productive one
// and freezes while sweeps are quiet (a skipped or empty cycle bumps
// `skippedSweeps` instead). `/api/health/sweep` answers 200 while the last
// productive sweep is within 3x the sweep interval, 503 otherwise — including
// when no productive sweep has happened yet.
import assert from "node:assert/strict";
import { test } from "node:test";
import { apiUrl } from "./support/config.js";

// An HTML document of any kind (Tomcat's status page, a framework error page):
// neither health endpoint may ever answer with one.
const HTML_PAGE = /<\s*(!doctype|html|head|body)\b/i;

async function get(path) {
  const res = await fetch(apiUrl(path));
  const contentType = String(res.headers.get("content-type") || "");
  const body = await res.text();
  return { status: res.status, contentType, body };
}

test("GET /api/health carries status/version/db and the sweep-freshness fields", async () => {
  const { status, contentType, body } = await get("/api/health");
  // 200 when the database answered the health SELECT, 503 when it did not; the
  // body is the same shape either way.
  assert.ok([200, 503].includes(status), `unexpected status ${status}: ${body}`);
  assert.ok(contentType.includes("application/json"), `expected JSON, got "${contentType}"`);

  const health = JSON.parse(body);
  assert.equal(typeof health.status, "string", "status must be a string");
  assert.ok(["UP", "DOWN"].includes(health.status), `status contract: "${health.status}"`);
  assert.equal(typeof health.db, "string", "db must be a string");
  assert.ok(["UP", "DOWN"].includes(health.db), `db contract: "${health.db}"`);
  // The overall status mirrors the one real dependency the endpoint checks.
  assert.equal(health.status, health.db, "status must mirror db reachability");

  // version is the git SHA deploy.sh waits for before calling a deploy healthy.
  // CI builds the jar with -Dgit.sha=$GITHUB_SHA, so the two must be equal. Anywhere
  // else (a local jar) EXPECTED_VERSION may name it; with neither, the jar was built
  // without a SHA ("dev") or with a local one (a hex commit id).
  assert.equal(typeof health.version, "string", "version must be a string");
  const expectedVersion = process.env.EXPECTED_VERSION?.trim() || process.env.GITHUB_SHA?.trim();
  if (expectedVersion) {
    assert.equal(health.version, expectedVersion, "version must equal the SHA the jar was built with");
  } else {
    assert.match(health.version, /^(dev|[0-9a-f]{7,40})$/, "version must be \"dev\" or a commit SHA");
  }

  // lastSweepAt: ISO-8601 string once a productive sweep has run, null before.
  assert.ok(
    health.lastSweepAt === null || typeof health.lastSweepAt === "string",
    `lastSweepAt must be null or an ISO timestamp, got ${JSON.stringify(health.lastSweepAt)}`
  );
  if (typeof health.lastSweepAt === "string") {
    assert.ok(
      !Number.isNaN(Date.parse(health.lastSweepAt)),
      `lastSweepAt must be a parseable timestamp, got "${health.lastSweepAt}"`
    );
  }

  // lastSweepRows / skippedSweeps: non-negative integers.
  assert.equal(typeof health.lastSweepRows, "number", "lastSweepRows must be a number");
  assert.ok(
    Number.isInteger(health.lastSweepRows) && health.lastSweepRows >= 0,
    `lastSweepRows must be a non-negative integer, got ${health.lastSweepRows}`
  );
  assert.equal(typeof health.skippedSweeps, "number", "skippedSweeps must be a number");
  assert.ok(
    Number.isInteger(health.skippedSweeps) && health.skippedSweeps >= 0,
    `skippedSweeps must be a non-negative integer, got ${health.skippedSweeps}`
  );

  // A productive sweep is the only thing that sets both fields: no stamp
  // means no rows written, and vice versa.
  if (health.lastSweepAt === null) {
    assert.equal(health.lastSweepRows, 0, "no lastSweepAt means no rows were written");
  }
});

test("GET /api/health/sweep answers 200 or 503, never an HTML error page", async () => {
  const { status, contentType, body } = await get("/api/health/sweep");
  assert.ok([200, 503].includes(status), `expected 200 or 503, got ${status}: ${body}`);
  assert.ok(
    !contentType.includes("text/html"),
    `the sweep check must not answer with an HTML page, got "${contentType}"`
  );
  assert.ok(!HTML_PAGE.test(body), `the sweep check must not answer with an HTML page:\n${body}`);
  // The endpoint has no documented body; whatever it returns in a body must be
  // JSON if anything at all.
  if (body !== "") {
    assert.ok(contentType.includes("application/json"), `non-empty body must be JSON, got "${contentType}"`);
    JSON.parse(body);
  }
});

// Must match flighttracker.agents.global-sweep-interval-seconds (360 in application.yml).
const SWEEP_INTERVAL_SECONDS = Number(process.env.SWEEP_INTERVAL_SECONDS || 360);
const STALE_AFTER_MS = SWEEP_INTERVAL_SECONDS * 3 * 1000;
// Within this of the 3x boundary the two clocks and the two requests can disagree: no assertion.
const BOUNDARY_SLACK_MS = 10_000;

async function readHealth() {
  return JSON.parse((await get("/api/health")).body);
}

// How long to wait, and how often to look, for a productive global sweep to land before
// concluding none can happen here. A fresh jar seeds one at boot when its database is
// empty (AgentOrchestrator.seedOnStartup) and then sweeps on its own schedule, so with a
// reachable data source the stamp is usually already there on the first read; an offline
// jar never stamps it, and waiting the whole sweep interval out would only slow the suite.
const SWEEP_WAIT_MS = Number(process.env.SWEEP_WAIT_MS || 60_000);
const SWEEP_POLL_MS = 2_000;

/** Poll /api/health until a productive sweep has stamped lastSweepAt, or the bound expires. */
async function waitForProductiveSweep() {
  const deadline = Date.now() + SWEEP_WAIT_MS;
  let health = await readHealth();
  while (health.lastSweepAt === null && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, SWEEP_POLL_MS));
    health = await readHealth();
  }
  return health;
}

test("the sweep check agrees with the freshness fields once a productive sweep has landed", async (t) => {
  // Reopen the poll window first (the call the frontend itself makes). It does not run a
  // global sweep — only that sweep stamps lastSweepAt — but this is the app's own
  // "start doing work now" request, and a sweep is what we then wait for.
  await fetch(apiUrl("/api/agents/restart"), { method: "POST" }).catch(() => {});

  const landed = await waitForProductiveSweep();
  if (landed.lastSweepAt === null) {
    // No productive sweep can happen here: the jar has no reachable data source, so the
    // global sweep writes nothing and never advances lastSweepAt. The 3x-interval
    // agreement is then untestable — say so loudly rather than passing on a branch that
    // never ran.
    t.skip(
      `no productive global sweep within ${SWEEP_WAIT_MS / 1000}s: this jar's data source ` +
        `is unreachable (an offline repro), so lastSweepAt stays null and the 3x-interval ` +
        `agreement cannot be asserted here.`
    );
    return;
  }

  // A productive sweep exists: 200 within 3x the interval, 503 once it is staler than
  // that. lastSweepAt only moves forward, so read /api/health either side of the sweep
  // check and assert only while it held still (a sweep landing mid-test would make the
  // pair inconsistent for a legitimate reason).
  for (let attempt = 0; attempt < 5; attempt++) {
    const before = await readHealth();
    const sweep = await get("/api/health/sweep");
    const after = await readHealth();
    assert.ok([200, 503].includes(sweep.status), `unexpected sweep status ${sweep.status}`);
    if (before.lastSweepAt !== after.lastSweepAt) continue;
    assert.notEqual(before.lastSweepAt, null, "a sweep has landed, so lastSweepAt must still be set");

    const ageMs = Date.now() - Date.parse(before.lastSweepAt);
    if (Math.abs(ageMs - STALE_AFTER_MS) < BOUNDARY_SLACK_MS) return; // too close to the edge to call
    assert.equal(
      sweep.status,
      ageMs < STALE_AFTER_MS ? 200 : 503,
      `lastSweepAt is ${Math.round(ageMs / 1000)}s old (stale after ${STALE_AFTER_MS / 1000}s), ` +
        `so /api/health/sweep must be ${ageMs < STALE_AFTER_MS ? 200 : 503}, got ${sweep.status}`
    );
    return;
  }
  assert.fail("lastSweepAt kept changing across five reads; cannot compare it with /api/health/sweep");
});
