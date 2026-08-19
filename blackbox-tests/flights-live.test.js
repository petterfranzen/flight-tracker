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

test("GET /api/flights/live honors an explicit withinMinutes", async () => {
  const res = await fetch(apiUrl("/api/flights/live?withinMinutes=60"));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body));
});

test("GET /api/flights/live?withinMinutes=0 returns an empty (or near-empty) array, not an error", async () => {
  // withinMinutes=0 means "since right now" — nothing should qualify as
  // strictly newer than the request instant.
  const res = await fetch(apiUrl("/api/flights/live?withinMinutes=0"));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body));
});

test("GET /api/flights/live rejects a non-numeric withinMinutes", async () => {
  const res = await fetch(apiUrl("/api/flights/live?withinMinutes=not-a-number"));
  assert.equal(res.status, 400);
});
