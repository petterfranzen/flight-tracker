import { test } from "node:test";
import assert from "node:assert/strict";
import { apiUrl } from "./support/config.js";
import { assertAircraftUsageShape, assertRequiresFromTo } from "./support/assertions.js";

const HOUR_MS = 60 * 60 * 1000;
const NOW = new Date();
const hoursAgo = (hours) => new Date(NOW.getTime() - hours * HOUR_MS).toISOString();

function usageUrl(from, to) {
  return apiUrl(`/api/usage?from=${from}&to=${to}`);
}

async function assertBadRequest(from, to) {
  const res = await fetch(usageUrl(from, to));
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.deepEqual(Object.keys(body), ["error"], `unexpected error body: ${JSON.stringify(body)}`);
}

test("GET /api/usage returns a well-shaped array over a one-hour window", async () => {
  const res = await fetch(usageUrl(hoursAgo(1), NOW.toISOString()));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body));
  for (const usage of body) assertAircraftUsageShape(usage);
});

test("GET /api/usage allows a window of exactly 24 hours", async () => {
  const res = await fetch(usageUrl(hoursAgo(24), NOW.toISOString()));
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(await res.json()));
});

test("GET /api/usage rejects a 72-hour window", async () => {
  await assertBadRequest(hoursAgo(72), NOW.toISOString());
});

test("GET /api/usage requires both from and to", async () => {
  await assertRequiresFromTo("/api/usage", hoursAgo(1), NOW.toISOString());
});

test("GET /api/usage rejects a malformed timestamp", async () => {
  const res = await fetch(usageUrl("not-a-timestamp", NOW.toISOString()));
  assert.equal(res.status, 400);
});

test("GET /api/usage rejects from after to", async () => {
  await assertBadRequest(NOW.toISOString(), hoursAgo(1));
});

test("GET /api/usage rejects a zero-width window", async () => {
  const instant = NOW.toISOString();
  await assertBadRequest(instant, instant);
});
