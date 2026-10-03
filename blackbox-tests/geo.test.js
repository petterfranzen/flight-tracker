import { test } from "node:test";
import assert from "node:assert/strict";
import { BASE_URL, apiUrl } from "./support/config.js";

// GET /api/geo: the visitor's approximate location from Cloudflare's headers
// (GeoLocator). 200 {lat, lon, precision} or 204 when there is nothing usable.

const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(BASE_URL);

function assertGeoShape(body) {
  assert.equal(typeof body.lat, "number");
  assert.equal(typeof body.lon, "number");
  assert.ok(body.lat >= -90 && body.lat <= 90, "lat out of range");
  assert.ok(body.lon >= -180 && body.lon <= 180, "lon out of range");
  assert.ok(["city", "country"].includes(body.precision), `unexpected precision ${body.precision}`);
}

test("GET /api/geo answers 200 with a point or 204, never cached", async () => {
  const res = await fetch(apiUrl("/api/geo"));
  assert.ok([200, 204].includes(res.status), `status ${res.status}`);
  assert.match(res.headers.get("cache-control") ?? "", /no-store/);
  if (res.status === 200) assertGeoShape(await res.json());
});

test("GET /api/geo: with no Cloudflare headers a local server has no location", { skip: !isLocal }, async () => {
  const res = await fetch(apiUrl("/api/geo"));
  assert.equal(res.status, 204);
});

test("GET /api/geo: Cloudflare's coordinates are used (rounded to 0.1 degree)", { skip: !isLocal }, async () => {
  const res = await fetch(apiUrl("/api/geo"), { headers: { "CF-IPLatitude": "53.4808", "CF-IPLongitude": "-2.2426" } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assertGeoShape(body);
  assert.deepEqual([body.lat, body.lon, body.precision], [53.5, -2.2, "city"]);
});

test("GET /api/geo: the country capital stands in when only the country is known", { skip: !isLocal }, async () => {
  const res = await fetch(apiUrl("/api/geo"), { headers: { "CF-IPCountry": "GB" } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual([body.lat, body.lon, body.precision], [51.5, -0.1, "country"]);
});
