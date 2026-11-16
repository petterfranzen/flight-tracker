// The happy path of optional social login, black box (social login step 4,
// task 2). A *second* jar, with the profile flag on and its Google registration
// pointed at the suite's hermetic fake OIDC provider, is driven through the
// whole round-trip over HTTP alone: an anonymous profile read is a 401, the
// app's own authorize endpoint 302s to the provider asking for `openid` and
// nothing else, the provider sends the browser back to the app's callback, and
// that callback turns the code into a session -- a new FT_SESSION, HttpOnly and
// SameSite=Lax, with which `GET /api/profile` answers. The last check is the
// negative half: with the flag on, `/api/health` still creates no session.
//
// It deliberately does not use `BASE_URL` or `support/config.js`: those point at
// the shared jar on 8080, which does not have this feature configured, and
// pointing this one at it would make the test pass or fail for the wrong reason.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { startFakeOidc } from "./support/fake-oidc.js";
import { LOGIN_CLIENT_ID, resolveJar, startLoginApp } from "./support/login-app.js";

const SUBJECT = "bb-login-subject-1";
const SESSION_COOKIE = "FT_SESSION";

// Started lazily inside the test, closed in the `after` hook below whichever way
// the test ends.
let provider;
let app;

after(async () => {
  app?.stop();
  await provider?.close();
});

// A missing jar is a skip locally (nothing built yet) and a failure in CI, where
// the artifact is meant to be downloaded before this runs.
const jarBuilt = resolveJar() !== null;
const skip = jarBuilt || process.env.CI ? false : "no flight-tracker jar built; set FT_JAR or build backend/target/flight-tracker.jar";

// The tiniest possible cookie jar: `fetch` has none, and the login spans three
// requests that must look like one browser. Only name=value is replayed -- the
// attributes on Set-Cookie belong to the browser, not the wire.
function createJar() {
  const cookies = new Map();
  return {
    header: () => [...cookies].map(([name, value]) => `${name}=${value}`).join("; "),
    absorb: (rawCookies) => {
      for (const raw of rawCookies) {
        const pair = raw.split(";")[0];
        const eq = pair.indexOf("=");
        cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1));
      }
    },
  };
}

/** One hop, never following a redirect: the URLs in these hops are half the assertions. */
async function hop(url, jar) {
  const headers = jar ? { cookie: jar.header() } : {};
  const res = await fetch(url, { redirect: "manual", headers });
  const rawCookies = res.headers.getSetCookie();
  jar?.absorb(rawCookies);
  return { res, rawCookies };
}

/** The value of `name` from a raw Set-Cookie list, or undefined if it was not set. */
function cookieValue(rawCookies, name) {
  const raw = rawCookies.find((entry) => entry.startsWith(`${name}=`));
  return raw?.split(";")[0].slice(name.length + 1);
}

function assertSessionCookieHardened(rawCookies) {
  const raw = rawCookies.find((entry) => entry.startsWith(`${SESSION_COOKIE}=`));
  assert.ok(raw, `${SESSION_COOKIE} must be set by the completed login`);
  assert.match(raw, /;\s*HttpOnly/i, "the session cookie must be HttpOnly");
  assert.match(raw, /;\s*SameSite=Lax/i, "the session cookie must be SameSite=Lax");
  assert.doesNotMatch(raw, /;\s*Secure/i, "SESSION_COOKIE_SECURE=false must leave the loopback cookie non-Secure");
}

test("a real login against the fake provider yields a session and exactly the provider id", { skip }, async () => {
  provider = await startFakeOidc({ clientId: LOGIN_CLIENT_ID, subject: SUBJECT });
  app = await startLoginApp({ fake: provider });
  const jar = createJar();

  // 1. Anonymous: the profile endpoint is the only thing the feature protects,
  //    and it answers plainly rather than redirecting to a login page.
  const anonymous = await hop(`${app.baseUrl}/api/profile`, null);
  assert.equal(anonymous.res.status, 401, "an anonymous profile read is a 401");

  // 2. The app's authorize endpoint redirects to the fake provider, asking for
  //    the one scope that carries no personal data -- and opening a session to
  //    remember the request while the browser is away.
  const authorize = await hop(`${app.baseUrl}/oauth2/authorization/google`, jar);
  assert.equal(authorize.res.status, 302, "/oauth2/authorization/google must redirect");
  const providerUrl = new URL(authorize.res.headers.get("location"));
  assert.equal(
    `${providerUrl.origin}${providerUrl.pathname}`,
    `${provider.issuer}/authorize`,
    "the redirect must go to the fake provider's authorize endpoint"
  );
  assert.deepEqual(providerUrl.searchParams.getAll("scope"), ["openid"], "only scope=openid may be requested");
  const beforeLogin = cookieValue(authorize.rawCookies, SESSION_COOKIE);
  assert.ok(beforeLogin, "starting a login must open a session so the request can be remembered");

  // 3. The provider redirects back to the app's callback; the callback (carrying
  //    the session from step 2, so Spring can match the state) redeems the code
  //    at the fake token endpoint and signs the browser in.
  const back = await hop(providerUrl, null);
  assert.equal(back.res.status, 302, "the provider must redirect back to the app");
  const callbackUrl = new URL(back.res.headers.get("location"));
  assert.equal(callbackUrl.origin, app.baseUrl, "the callback must land on this jar");
  assert.equal(callbackUrl.pathname, "/login/oauth2/code/google");
  assert.equal(provider.seen.authorize.length, 1, "the provider must have seen exactly one authorize request");

  const login = await hop(callbackUrl, jar);
  assert.equal(login.res.status, 302, "a completed login redirects back into the app");
  assertSessionCookieHardened(login.rawCookies);
  const afterLogin = cookieValue(login.rawCookies, SESSION_COOKIE);
  assert.ok(afterLogin, "the completed login must set a session cookie");
  assert.notEqual(afterLogin, beforeLogin, "the session id must change at login");

  // 4. With that session the profile read is the provider id and nothing else --
  //    no email, no name, no avatar, because none was ever asked for.
  const profile = await hop(`${app.baseUrl}/api/profile`, jar);
  assert.equal(profile.res.status, 200);
  assert.equal(await profile.res.text(), '{"provider":"google"}');

  // 5. The negative half: the feature must not have made every request stateful.
  //    An anonymous health check is answered without a session. The one cookie the
  //    flag-on chain does add to any response it writes is the readable CSRF token
  //    the SPA echoes back (XSRF-TOKEN, step 3b-2) -- it carries no identity, so
  //    it is allowed here, and nothing else is. (The task text said "sets no
  //    cookie"; against the shipped chain that is false, and the session cookie is
  //    what actually matters -- flagged on the PR.)
  const health = await hop(`${app.baseUrl}/api/health`, null);
  assert.equal(health.res.status, 200);
  assert.ok(
    !health.rawCookies.some((raw) => raw.startsWith(`${SESSION_COOKIE}=`)),
    "/api/health on the flag-on jar must not open a session"
  );
  for (const raw of health.rawCookies) {
    assert.ok(raw.startsWith("XSRF-TOKEN="), `only the CSRF token cookie may be set, got: ${raw}`);
  }
});
