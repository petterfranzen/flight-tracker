// The local-jar twin of the post-deploy smoke test's security checks
// (scripts/smoke-prod.sh, docs/smoke-test.md): the same four headers on both
// paths, and the same two /ws/live handshakes — the public site's Origin must
// open the socket, a foreign one must be refused with 403.
//
// Nothing here depends on live traffic, so unlike live-feed.test.js these
// assertions are decisive wherever the suite runs.

import test from "node:test";
import assert from "node:assert/strict";
import { BASE_URL, apiUrl } from "./support/config.js";
import { assertLiveMarkerShape } from "./support/assertions.js";
import { openSocket, firstFrame } from "./support/ws-upgrade.js";

// The Origin a browser on the public site sends. It is on the app's default
// allow-list (application.yml's flighttracker.ws.allowed-origins) and is never
// same-origin with a local test target, so a 101 here proves the allow-list is
// being applied — not Spring's same-origin bypass.
const PUBLIC_ORIGIN = process.env.WS_ALLOWED_ORIGIN?.trim() || "https://flight.pastabake.cloud";
const FOREIGN_ORIGIN = process.env.WS_FOREIGN_ORIGIN?.trim() || "https://evil.example";
// Set when the jar under test was started with FLIGHTTRACKER_CSP_REPORT_ONLY=true.
const CSP_REPORT_ONLY = process.env.CSP_REPORT_ONLY === "true";
const FRAME_TIMEOUT_MS = Number(process.env.WS_FRAME_TIMEOUT_MS || 15000);
// The Baltic/Stockholm box the app itself falls back to (ViewportService.DEFAULT),
// and the one the post-deploy smoke script reports. The feed filters its
// broadcast by the last reported viewport and a map nobody has open reports
// nothing, so the frame is only ever pushed after this.
const BBOX = "latMin=54&latMax=66&lonMin=10&lonMax=25";

const REQUIRED_HEADERS = [
  ["x-content-type-options", /nosniff/],
  ["referrer-policy", /strict-origin-when-cross-origin/],
  ["permissions-policy", /camera=\(\)/],
];

test("security headers are on / and /api/health", async (t) => {
  const csp = CSP_REPORT_ONLY ? "content-security-policy-report-only" : "content-security-policy";
  for (const path of ["/", "/api/health"]) {
    await t.test(path, async () => {
      const res = await fetch(apiUrl(path));
      assert.equal(
        res.status,
        200,
        `${path} answered ${res.status} — is this the frontend-bundled jar (mvn -Pwith-frontend)?`,
      );
      const policy = res.headers.get(csp);
      assert.ok(policy, `${path} is missing ${csp}`);
      assert.match(policy, /frame-ancestors 'none'/, `${path} ${csp} is ${policy}`);
      for (const [name, pattern] of REQUIRED_HEADERS) {
        const value = res.headers.get(name);
        assert.ok(value, `${path} is missing ${name}`);
        assert.match(value, pattern, `${path} ${name} is ${value}`);
      }
    });
  }
});

test("/ws/live accepts the public site's Origin and pushes a LiveFrame", async (t) => {
  await fetch(apiUrl(`/api/flights/live?${BBOX}`)).catch(() => {});
  const conn = await openSocket(BASE_URL, PUBLIC_ORIGIN);
  try {
    assert.equal(
      conn.status,
      101,
      `handshake with Origin ${PUBLIC_ORIGIN} answered ${conn.status}, expected 101 — is it on flighttracker.ws.allowed-origins?`,
    );
    const frame = await firstFrame(conn, FRAME_TIMEOUT_MS);
    if (frame === null) {
      // Same stance as live-feed.test.js: the feed only pushes while the hot
      // poll runs, so with no OpenSky traffic there is nothing to push. The
      // handshake above is the security assertion; the frame is the bonus.
      t.diagnostic(`no LiveFrame within ${FRAME_TIMEOUT_MS}ms — no live traffic to push (handshake still 101)`);
      return;
    }
    assertLiveMarkerShape(JSON.parse(frame));
  } finally {
    conn.socket?.destroy();
  }
});

test("/ws/live refuses a foreign Origin with 403", async () => {
  const conn = await openSocket(BASE_URL, FOREIGN_ORIGIN);
  try {
    assert.equal(
      conn.status,
      403,
      `handshake with Origin ${FOREIGN_ORIGIN} answered ${conn.status}, expected 403 — the allow-list is not rejecting a foreign site`,
    );
  } finally {
    conn.socket?.destroy();
  }
});
