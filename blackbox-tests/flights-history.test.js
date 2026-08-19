import { test } from "node:test";
import assert from "node:assert/strict";
import { apiUrl } from "./support/config.js";
import { assertFlightPositionShape, assertRequiresFromTo } from "./support/assertions.js";

const NOW = new Date();
const SIX_HOURS_AGO = new Date(NOW.getTime() - 6 * 60 * 60 * 1000);

test("GET /api/flights/{icao24}/history returns a well-shaped array for a real-looking icao24", async () => {
  const url = apiUrl(
    `/api/flights/aaaaaa/history?from=${SIX_HOURS_AGO.toISOString()}&to=${NOW.toISOString()}`
  );
  const res = await fetch(url);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body));
  for (const pos of body) assertFlightPositionShape(pos);
});

test("GET /api/flights/{icao24}/history for an aircraft with no history returns an empty array, not 404", async () => {
  const url = apiUrl(
    `/api/flights/zzzzzz/history?from=${SIX_HOURS_AGO.toISOString()}&to=${NOW.toISOString()}`
  );
  const res = await fetch(url);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, []);
});

test("GET /api/flights/{icao24}/history requires both from and to", async () => {
  await assertRequiresFromTo("/api/flights/aaaaaa/history", SIX_HOURS_AGO.toISOString(), NOW.toISOString());
});

test("GET /api/flights/{icao24}/history rejects a malformed timestamp", async () => {
  const url = apiUrl(`/api/flights/aaaaaa/history?from=not-a-timestamp&to=${NOW.toISOString()}`);
  const res = await fetch(url);
  assert.equal(res.status, 400);
});

test("GET /api/flights/{icao24}/history with from after to returns an empty array rather than erroring", async () => {
  const url = apiUrl(
    `/api/flights/aaaaaa/history?from=${NOW.toISOString()}&to=${SIX_HOURS_AGO.toISOString()}`
  );
  const res = await fetch(url);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, []);
});
