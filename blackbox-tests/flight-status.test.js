import { test } from "node:test";
import assert from "node:assert/strict";
import { apiUrl } from "./support/config.js";

const STATES = ["LIVE", "COVERAGE_LOST", "LANDED_INFERRED", "ON_GROUND", "LANDED_CONFIRMED", "AT_GATE"];
const KINDS = ["observed", "inferred", "confirmed"];
const TOP_LEVEL_KEYS = [
  "icao24", "state", "confidence", "source", "sourceKind",
  "lastSeenAt", "lastSeenLat", "lastSeenLon",
  "estimate", "landing", "gate", "terminal", "confirmedAt",
];

function assertIso(value, what) {
  assert.equal(typeof value, "string", `${what} must be an ISO-8601 string`);
  assert.ok(!Number.isNaN(Date.parse(value)), `${what} (${value}) must parse as a date`);
}

function assertStatusShape(status, icao24) {
  assert.deepEqual(Object.keys(status).sort(), [...TOP_LEVEL_KEYS].sort());
  assert.equal(status.icao24, icao24);
  assert.ok(STATES.includes(status.state), `unknown state ${status.state}`);
  assert.ok(KINDS.includes(status.sourceKind), `unknown sourceKind ${status.sourceKind}`);
  assert.equal(typeof status.source, "string");
  if (status.state === "LIVE") assert.equal(status.confidence, null);
  else assert.ok(status.confidence >= 0 && status.confidence <= 1, "confidence must be in 0..1");
  assertIso(status.lastSeenAt, "lastSeenAt");
  assert.equal(typeof status.lastSeenLat, "number");
  assert.equal(typeof status.lastSeenLon, "number");

  const inferred = status.state === "COVERAGE_LOST" || status.state === "LANDED_INFERRED";
  if (inferred) {
    assert.deepEqual(Object.keys(status.estimate).sort(), ["at", "landingProbability", "lat", "lon", "radiusM"]);
    assertIso(status.estimate.at, "estimate.at");
    assert.ok(status.estimate.radiusM >= 0);
    assert.ok(status.estimate.landingProbability >= 0 && status.estimate.landingProbability <= 1);
  } else {
    assert.equal(status.estimate, null);
  }
  if (status.landing !== null) {
    assert.deepEqual(Object.keys(status.landing).sort(), ["airportIcao", "runway", "touchdownAt"]);
    assert.equal(typeof status.landing.airportIcao, "string");
    assertIso(status.landing.touchdownAt, "landing.touchdownAt");
  }
  // Reserved for confirmation providers: present, and null in phase 1.
  assert.equal(status.gate, null);
  assert.equal(status.terminal, null);
  assert.equal(status.confirmedAt, null);
}

test("GET /api/flights/{icao24}/status returns 404 for an unknown aircraft", async () => {
  const res = await fetch(apiUrl("/api/flights/000000/status"));
  assert.equal(res.status, 404);
});

test("GET /api/flights/{icao24}/status returns the status contract for a live aircraft", async (t) => {
  const liveRes = await fetch(apiUrl("/api/flights/live?latMin=-90&latMax=90&lonMin=-180&lonMax=180"));
  assert.equal(liveRes.status, 200);
  const live = await liveRes.json();
  if (live.length === 0) {
    t.skip("no live aircraft to ask about (the data source may be unreachable)");
    return;
  }

  const icao24 = live[0].icao24;
  const res = await fetch(apiUrl(`/api/flights/${icao24}/status`));
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /application\/json/);
  assertStatusShape(await res.json(), icao24);
});
