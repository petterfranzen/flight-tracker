// The public app's error responses must not say what is serving them.
//
// Spring Boot's default error body (`timestamp`/`status`/`error`/`path`, and a
// "Whitelabel Error Page" for an HTML client) and Tomcat's own status page for
// a request the container rejects are both well-known fingerprints of the
// stack — the same thing `/api/ops/stats` is deliberately careful not to do.
// These tests assert the generic contract over real HTTP: a single `error`
// field for the app's own 404/405/400/500, an empty body for a container-level
// 400, and no framework name or version anywhere in a body or a header.
import assert from "node:assert/strict";
import { test } from "node:test";
import http from "node:http";
import { apiUrl, BASE_URL } from "./support/config.js";

// Lower-cased substrings that would name a framework, a container or a piece of
// one. Deliberately broad — a false positive is a review conversation, a false
// negative is the bug this file exists to catch.
const FINGERPRINTS = [
  "spring", "springframework", "tomcat", "whitelabel", "catalina", "coyote",
  "apache", "hibernate", "jackson", "undertow", "jetty", "servlet", "java",
  "no explicit mapping", "timestamp", "stacktrace", "exception",
];

// A version-ish token (e.g. "Tomcat/11.0.27" or "3.3.4"): the app's error
// responses should carry none at all.
const VERSION = /\b\d+\.\d+\.\d+\b/;

function assertNeutral(status, headers, body) {
  const flat = [body, ...Object.entries(headers).flatMap(([k, v]) => [k, ...(Array.isArray(v) ? v : [v])])]
    .filter((s) => typeof s === "string")
    .join("\n");
  const haystack = flat.toLowerCase();
  for (const needle of FINGERPRINTS) {
    assert.ok(
      !haystack.includes(needle),
      `${status} response names the stack ("${needle}"):\n${flat}`
    );
  }
  assert.ok(!VERSION.test(flat), `${status} response leaks a version number:\n${flat}`);
}

// The app's own errors: one generic field, JSON, never an HTML error page.
async function assertGenericJson(res) {
  const contentType = String(res.headers.get("content-type") || "");
  assert.ok(
    contentType.includes("application/json"),
    `expected a JSON error body, got "${contentType}"`
  );
  const body = await res.text();
  assertNeutral(res.status, Object.fromEntries(res.headers), body);
  assert.deepEqual(
    Object.keys(JSON.parse(body)),
    ["error"],
    `error body should carry one generic field, got: ${body}`
  );
  return JSON.parse(body);
}

// A raw request, so the path is sent exactly as written — fetch/undici would
// normalise some of these before the server ever sees them.
function rawGet(path) {
  return new Promise((resolve, reject) => {
    const { hostname, port } = new URL(BASE_URL);
    const req = http.request({ hostname, port, path, method: "GET" }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("404 from an unknown API path is generic", async () => {
  const res = await fetch(apiUrl("/api/definitely-not-a-route"));
  assert.equal(res.status, 404);
  const { error } = await assertGenericJson(res);
  assert.equal(error, "Not Found");
});

test("404 for an HTML client is JSON, not a whitelabel page", async () => {
  const res = await fetch(apiUrl("/api/definitely-not-a-route"), {
    headers: { accept: "text/html,application/xhtml+xml" },
  });
  assert.equal(res.status, 404);
  assert.ok(
    !String(res.headers.get("content-type") || "").includes("text/html"),
    "an HTML client must not be handed a framework error page"
  );
  await assertGenericJson(res);
});

test("405 for a method the route does not allow is generic", async () => {
  const res = await fetch(apiUrl("/api/health"), { method: "POST" });
  assert.equal(res.status, 405);
  const { error } = await assertGenericJson(res);
  assert.equal(error, "Method Not Allowed");
});

test("400 for a request the app rejects is generic", async () => {
  // /api/usage requires `from` and `to`; omitting them is a 400 the MVC layer
  // raises, so it takes the error-dispatch path.
  const res = await fetch(apiUrl("/api/usage"));
  assert.equal(res.status, 400);
  const { error } = await assertGenericJson(res);
  assert.equal(error, "Bad Request");
});

test("400 for a request the container itself rejects is empty, not a Tomcat page", async () => {
  const res = await rawGet("/%");
  assert.equal(res.status, 400);
  assert.equal(res.body, "", "container-level errors must not carry a container error page");
  assertNeutral(res.status, res.headers, res.body);
});

test("500 from the error dispatch is generic", async () => {
  // /error is the container's error page path; a direct GET of it is served by
  // the same generic controller and answers 500. There is no endpoint in the
  // app that throws on demand, so this is the reachable 500.
  const res = await fetch(apiUrl("/error"));
  assert.equal(res.status, 500);
  const { error } = await assertGenericJson(res);
  assert.equal(error, "Internal Server Error");
});
