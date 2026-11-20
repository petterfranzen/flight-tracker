// Optional social login, black box (social login step 4, tasks 2 and 3). A
// *second* jar, with the profile flag on and its Google registration pointed at
// the suite's hermetic fake OIDC provider, is driven over HTTP alone. Three
// things are proved here:
//
//  * the happy path -- an anonymous profile read is a 401, the app's own
//    authorize endpoint 302s to the provider asking for `openid` and nothing
//    else, the provider sends the browser back to the app's callback, and that
//    callback turns the code into a session (a new FT_SESSION, HttpOnly and
//    SameSite=Lax) with which `GET /api/profile` answers;
//  * sign-out -- `POST /api/auth/logout` without the CSRF token the SPA echoes
//    back is a 403 and leaves the session alone; with it, a 204 that clears the
//    cookie, after which the profile read is a 401 again;
//  * every way a login can be refused (a tampered state, a wrong nonce, issuer,
//    audience, an expired token, a token signed with an unknown key) lands on the
//    same relative `/?error` redirect with nobody signed in -- and, with the flag
//    on, `POST /api/health` keeps its 405 rather than becoming a CSRF 403.
//
// It deliberately does not use `BASE_URL` or `support/config.js`: those point at
// the shared jar on 8080, which does not have this feature configured, and
// pointing this one at it would make the test pass or fail for the wrong reason.
// The jar and the provider are started once in `before()` and shared by every
// case: a boot per case would dominate the run, and none of them need a fresh
// app. The fake's `mode` and request log are reset before each case.
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { startFakeOidc } from "./support/fake-oidc.js";
import { LOGIN_CLIENT_ID, resolveJar, startLoginApp } from "./support/login-app.js";

const SUBJECT = "bb-login-subject-1";
const SESSION_COOKIE = "FT_SESSION";
const CSRF_COOKIE = "XSRF-TOKEN";
const CSRF_HEADER = "X-XSRF-TOKEN";

// A missing jar is a skip locally (nothing built yet) and a failure in CI, where
// the artifact is meant to be downloaded before this runs.
const jarBuilt = resolveJar() !== null;
const skip = jarBuilt || process.env.CI ? false : "no flight-tracker jar built; set FT_JAR or build backend/target/flight-tracker.jar";

// The one jar and the one provider the whole file shares, started in `before()`
// and torn down in `after()` whichever way the tests end.
let provider;
let app;

before(async () => {
  if (skip) {
    return; // nothing to start when every case is skipped
  }
  provider = await startFakeOidc({ clientId: LOGIN_CLIENT_ID, subject: SUBJECT });
  app = await startLoginApp({ fake: provider });
});

after(async () => {
  app?.stop();
  await provider?.close();
});

// Each case starts from the same provider: sound tokens, an empty request log.
// The app itself is left alone -- waiting for a fresh boot between cases would
// cost more than the whole suite.
beforeEach(() => {
  if (!provider) {
    return;
  }
  provider.mode.v = "ok";
  provider.seen.authorize.length = 0;
  provider.seen.token.length = 0;
});

// The tiniest possible cookie jar: `fetch` has none, and the login spans three
// requests that must look like one browser. Only name=value is replayed -- the
// attributes on Set-Cookie belong to the browser, not the wire.
function createJar() {
  const cookies = new Map();
  return {
    header: () => [...cookies].map(([name, value]) => `${name}=${value}`).join("; "),
    value: (name) => cookies.get(name),
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
async function hop(url, jar, init = {}) {
  const headers = { ...(init.headers ?? {}) };
  if (jar) {
    headers.cookie = jar.header();
  }
  const res = await fetch(url, { ...init, redirect: "manual", headers });
  const rawCookies = res.headers.getSetCookie();
  jar?.absorb(rawCookies);
  return { res, rawCookies };
}

/** The value of `name` from a raw Set-Cookie list, or undefined if it was not set. */
function cookieValue(rawCookies, name) {
  const raw = rawCookies.find((entry) => entry.startsWith(`${name}=`));
  return raw?.split(";")[0].slice(name.length + 1);
}

const setsSessionCookie = (rawCookies) => rawCookies.some((raw) => raw.startsWith(`${SESSION_COOKIE}=`));

function assertSessionCookieHardened(rawCookies) {
  const raw = rawCookies.find((entry) => entry.startsWith(`${SESSION_COOKIE}=`));
  assert.ok(raw, `${SESSION_COOKIE} must be set by the completed login`);
  assert.match(raw, /;\s*HttpOnly/i, "the session cookie must be HttpOnly");
  assert.match(raw, /;\s*SameSite=Lax/i, "the session cookie must be SameSite=Lax");
  assert.doesNotMatch(raw, /;\s*Secure/i, "SESSION_COOKIE_SECURE=false must leave the loopback cookie non-Secure");
}

/**
 * The whole authorization-code round trip over HTTP -- the only way a case gets
 * logged in. `mode` is the defect the fake applies to the id_token it mints (see
 * support/fake-oidc.js, which sets it before the callback redeems the code); and
 * `mutate` rewrites the URL the provider sends the browser back to, which is how
 * a state the app never issued is produced. Returns every hop for the assertions
 * that want the URLs, plus the final callback response as `login`.
 */
async function login(jar, { mode = "ok", mutate = null } = {}) {
  const authorize = await hop(`${app.baseUrl}/oauth2/authorization/google`, jar);
  assert.equal(authorize.res.status, 302, "/oauth2/authorization/google must redirect");
  const providerUrl = new URL(authorize.res.headers.get("location"));

  provider.mode.v = mode;
  const back = await hop(providerUrl, null);
  assert.equal(back.res.status, 302, "the fake provider must redirect back to the app");

  const callbackUrl = new URL(back.res.headers.get("location"));
  mutate?.(callbackUrl);
  const login = await hop(callbackUrl, jar);
  return { authorize, providerUrl, back, callbackUrl, login };
}

test("a real login against the fake provider yields a session and exactly the provider id", { skip }, async () => {
  const jar = createJar();

  // 1. Anonymous: the profile endpoint is the only thing the feature protects,
  //    and it answers plainly rather than redirecting to a login page.
  const anonymous = await hop(`${app.baseUrl}/api/profile`, null);
  assert.equal(anonymous.res.status, 401, "an anonymous profile read is a 401");

  // 2. The app's authorize endpoint redirects to the fake provider, asking for
  //    the one scope that carries no personal data -- and opening a session to
  //    remember the request while the browser is away.
  const { authorize, providerUrl, callbackUrl, login: done } = await login(jar);
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
  assert.equal(callbackUrl.origin, app.baseUrl, "the callback must land on this jar");
  assert.equal(callbackUrl.pathname, "/login/oauth2/code/google");
  assert.equal(provider.seen.authorize.length, 1, "the provider must have seen exactly one authorize request");

  assert.equal(done.res.status, 302, "a completed login redirects back into the app");
  assertSessionCookieHardened(done.rawCookies);
  const afterLogin = cookieValue(done.rawCookies, SESSION_COOKIE);
  assert.ok(afterLogin, "the completed login must set a session cookie");
  assert.notEqual(afterLogin, beforeLogin, "the session id must change at login");

  // 4. With that session the profile read is the provider id and the two lists of
  //    step 5a-2 (D4) -- empty for a brand-new profile, and with no profile id or
  //    subject anywhere -- plus no email, no name, no avatar, because none was ever
  //    asked for.
  const profile = await hop(`${app.baseUrl}/api/profile`, jar);
  assert.equal(profile.res.status, 200);
  assert.deepEqual(await profile.res.json(), { provider: "google", favorites: [], watched: [] });

  // 5. The negative half: the feature must not have made every request stateful.
  //    An anonymous health check is answered without a session. The one cookie the
  //    flag-on chain does add to any response it writes is the readable CSRF token
  //    the SPA echoes back (XSRF-TOKEN, step 3b-2) -- it carries no identity, so
  //    it is allowed here, and nothing else is. (The step-4 task text said "sets no
  //    cookie"; against the shipped chain that is false, and the session cookie is
  //    what actually matters -- flagged on the PR.)
  const health = await hop(`${app.baseUrl}/api/health`, null);
  assert.equal(health.res.status, 200);
  assert.ok(
    !setsSessionCookie(health.rawCookies),
    "/api/health on the flag-on jar must not open a session"
  );
  for (const raw of health.rawCookies) {
    assert.ok(raw.startsWith(`${CSRF_COOKIE}=`), `only the CSRF token cookie may be set, got: ${raw}`);
  }
});

test("logout without the CSRF token is a 403 and leaves the session alone", { skip }, async () => {
  const jar = createJar();
  await login(jar);
  assert.equal((await hop(`${app.baseUrl}/api/profile`, jar)).res.status, 200, "the fixture must start logged in");

  // The jar holds the XSRF-TOKEN cookie (the chain hands one out on every
  // response) but the SPA's echo is missing: the scoped CSRF rule refuses it.
  const denied = await hop(`${app.baseUrl}/api/auth/logout`, jar, { method: "POST" });
  assert.equal(denied.res.status, 403, "POST /api/auth/logout without X-XSRF-TOKEN must be a 403");
  assert.ok(!setsSessionCookie(denied.rawCookies), "a refused logout must not touch the session cookie");

  const stillLoggedIn = await hop(`${app.baseUrl}/api/profile`, jar);
  assert.equal(stillLoggedIn.res.status, 200, "a refused logout must not end the session");
});

test("logout with the CSRF cookie echoed back is a 204 that ends the session", { skip }, async () => {
  const jar = createJar();
  await login(jar);
  const token = jar.value(CSRF_COOKIE);
  assert.ok(token, "the flag-on chain must have handed out an XSRF-TOKEN cookie for the SPA to echo");

  const out = await hop(`${app.baseUrl}/api/auth/logout`, jar, { method: "POST", headers: { [CSRF_HEADER]: token } });
  assert.equal(out.res.status, 204, "a token-carrying logout is a 204");

  const cleared = out.rawCookies.find((raw) => raw.startsWith(`${SESSION_COOKIE}=`));
  assert.ok(cleared, "logout must Set-Cookie the session cookie so the browser drops it");
  assert.match(cleared, /^FT_SESSION=(;|$)/, "the cleared session cookie must carry no value");
  assert.match(cleared, /Max-Age=0/i, "the cleared session cookie must expire immediately");

  const afterLogout = await hop(`${app.baseUrl}/api/profile`, jar);
  assert.equal(afterLogout.res.status, 401, "the session must be gone once logged out");
});

// Every way the provider can be wrong, plus the one app-side mutation (a state
// the app never issued). One case each, one body: the callback refuses, nothing
// is signed in. `state` tampering is the app's own complaint, so the fake stays
// in `ok` mode for it.
const REJECTED_LOGINS = [
  { name: "a tampered state parameter", mode: "ok", mutate: (url) => url.searchParams.set("state", "bb-tampered-state") },
  { name: "a nonce the app never sent", mode: "nonce" },
  { name: "an id_token from another issuer", mode: "iss" },
  { name: "an id_token for another audience", mode: "aud" },
  { name: "an expired id_token", mode: "exp" },
  { name: "an id_token signed with an unpublished key", mode: "key" },
];

for (const rejected of REJECTED_LOGINS) {
  test(`a login refused for ${rejected.name} redirects to the SPA's error and signs nobody in`, { skip }, async () => {
    const jar = createJar();
    const { login: refused } = await login(jar, rejected);

    // A relative Location on purpose: an absolute one would leak the internal
    // host and port into a header the browser then follows (design: the SPA's
    // sign-in is at /, and its error state is ?error).
    assert.equal(refused.res.status, 302, "a refused login is still a redirect");
    assert.equal(refused.res.headers.get("location"), "/?error", "the refusal must redirect to the relative /?error");
    assert.ok(!setsSessionCookie(refused.rawCookies), "a refused login must not set a session cookie");

    const profile = await hop(`${app.baseUrl}/api/profile`, jar);
    assert.equal(profile.res.status, 401, "a refused login leaves nobody signed in");
  });
}

test("the flag-on chain keeps POST /api/health a 405, not a CSRF 403", { skip }, async () => {
  const res = await hop(`${app.baseUrl}/api/health`, null, { method: "POST" });
  assert.equal(res.res.status, 405, "CSRF protection must be scoped away from /api/health");
});
