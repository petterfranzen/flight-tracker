import { test } from "node:test";
import assert from "node:assert/strict";
import { apiUrl } from "./support/config.js";
import { assertFlightPositionShape } from "./support/assertions.js";

test("GET /api/flights/live returns an array of well-shaped positions", async () => {
  const res = await fetch(apiUrl("/api/flights/live"));
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /application\/json/);

  const body = await res.json();
  assert.ok(Array.isArray(body), "response body must be an array");
  for (const pos of body) assertFlightPositionShape(pos);
});

test("GET /api/flights/live only returns aircraft that are airborne or recently landed", async () => {
  // No query params anymore — the live/landed-visibility window is fixed
  // server-side (FlightController.STALE_AIRBORNE_BOUND / LANDED_VISIBILITY),
  // not caller-tunable. Every returned position should be either airborne
  // or on the ground (a landed aircraft still qualifies for up to 20min).
  const res = await fetch(apiUrl("/api/flights/live"));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body));
  for (const pos of body) assert.equal(typeof pos.onGround, "boolean");
});
