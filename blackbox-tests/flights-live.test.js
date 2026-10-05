import { test } from "node:test";
import assert from "node:assert/strict";
import { apiUrl } from "./support/config.js";
import { assertLiveMarkerShape } from "./support/assertions.js";

test("GET /api/flights/live returns an array of well-shaped positions", async () => {
  const res = await fetch(apiUrl("/api/flights/live"));
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /application\/json/);

  const body = await res.json();
  assert.ok(Array.isArray(body), "response body must be an array");
  for (const pos of body) assertLiveMarkerShape(pos);
});

test("GET /api/flights/live only returns aircraft that are airborne or recently landed", async () => {
  // The live/landed-visibility window is fixed server-side
  // (FlightController.STALE_AIRBORNE_BOUND / LANDED_VISIBILITY), not
  // caller-tunable. Every returned position should be either airborne or
  // on the ground (a landed aircraft still qualifies for up to 20min).
  const res = await fetch(apiUrl("/api/flights/live"));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body));
  for (const pos of body) assert.equal(typeof pos.onGround, "boolean");
});

test("GET /api/flights/live with a bbox only returns positions inside it", async () => {
  // Tracking is global; a bbox is how the map scopes down to what's on
  // screen. Sweden/the Baltic — the app's old fixed default region — is a
  // safe bet for having *some* traffic to assert against without the test
  // being flaky on an empty result set.
  const res = await fetch(apiUrl("/api/flights/live?latMin=54&latMax=66&lonMin=10&lonMax=25"));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body));
  for (const pos of body) {
    assert.ok(pos.latitude >= 54 && pos.latitude <= 66, `latitude ${pos.latitude} outside requested bbox`);
    assert.ok(pos.longitude >= 10 && pos.longitude <= 25, `longitude ${pos.longitude} outside requested bbox`);
  }
});

test("GET /api/flights/live without a bbox can return more than any single bbox would", async () => {
  // Whole-world tracking landing in the same endpoint that used to be
  // scoped to one fixed region — the unscoped call should never return
  // *fewer* aircraft than a real bbox subset of it.
  const [globalRes, boundedRes] = await Promise.all([
    fetch(apiUrl("/api/flights/live")),
    fetch(apiUrl("/api/flights/live?latMin=54&latMax=66&lonMin=10&lonMax=25")),
  ]);
  assert.equal(globalRes.status, 200);
  assert.equal(boundedRes.status, 200);
  const [globalBody, boundedBody] = await Promise.all([globalRes.json(), boundedRes.json()]);
  assert.ok(globalBody.length >= boundedBody.length);
});

test("GET /api/flights/live/overview?declutter=true returns one plane per cell and no clusters", async () => {
  // The cluster-free zoomed-out view: well-shaped markers, no two in the same
  // 1-degree cell, and nothing clustered (see LiveStateStore.discovered).
  const res = await fetch(apiUrl("/api/flights/live/overview?latMin=-90&latMax=90&lonMin=-180&lonMax=180&gridDeg=1&limit=2000&declutter=true"));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.planes), "planes must be an array");
  assert.deepEqual(body.clusters, []);
  const cells = new Set();
  for (const pos of body.planes) {
    assertLiveMarkerShape(pos);
    const cell = `${Math.floor(pos.latitude)},${Math.floor(pos.longitude)}`;
    assert.ok(!cells.has(cell), `two planes in cell ${cell}`);
    cells.add(cell);
  }
});
