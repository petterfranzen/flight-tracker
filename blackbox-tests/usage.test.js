import { test } from "node:test";
import assert from "node:assert/strict";
import { apiUrl } from "./support/config.js";
import { assertAircraftUsageShape, assertRequiresFromTo } from "./support/assertions.js";

const NOW = new Date();
const THIRTY_DAYS_AGO = new Date(NOW.getTime() - 30 * 24 * 60 * 60 * 1000);

test("GET /api/usage returns a well-shaped array over a wide window", async () => {
  const url = apiUrl(`/api/usage?from=${THIRTY_DAYS_AGO.toISOString()}&to=${NOW.toISOString()}`);
  const res = await fetch(url);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body));
  for (const usage of body) assertAircraftUsageShape(usage);
});

test("GET /api/usage requires both from and to", async () => {
  await assertRequiresFromTo("/api/usage", THIRTY_DAYS_AGO.toISOString(), NOW.toISOString());
});

test("GET /api/usage rejects a malformed timestamp", async () => {
  const url = apiUrl(`/api/usage?from=not-a-timestamp&to=${NOW.toISOString()}`);
  const res = await fetch(url);
  assert.equal(res.status, 400);
});

test("GET /api/usage with from after to returns an empty array rather than erroring", async () => {
  const url = apiUrl(`/api/usage?from=${NOW.toISOString()}&to=${THIRTY_DAYS_AGO.toISOString()}`);
  const res = await fetch(url);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, []);
});

test("GET /api/usage over a zero-width window returns an empty array", async () => {
  const instant = NOW.toISOString();
  const url = apiUrl(`/api/usage?from=${instant}&to=${instant}`);
  const res = await fetch(url);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, []);
});
