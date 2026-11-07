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
  // A build with no -Dgit.sha reports "dev"; it is always a non-empty string.
  assert.equal(typeof health.version, "string", "version must be a string");
  assert.ok(health.version.length > 0, "version must be present");

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

test("the sweep check agrees with the freshness fields on /api/health", async () => {
  const health = JSON.parse((await get("/api/health")).body);
  const sweep = await get("/api/health/sweep");
  assert.ok([200, 503].includes(sweep.status), `unexpected sweep status ${sweep.status}`);

  // With no productive sweep ever (OpenSky unreachable since boot is the usual
  // case for a fresh blackbox jar), the check cannot report healthy: it is 503.
  if (health.lastSweepAt === null) {
    assert.equal(
      sweep.status,
      503,
      "with lastSweepAt null (no productive sweep yet) /api/health/sweep must be 503"
    );
  }
});
