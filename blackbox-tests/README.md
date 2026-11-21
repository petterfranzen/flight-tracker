# Black-box API test suite

Exercises the flight-tracker system purely over HTTP/WebSocket — no JVM,
no repository classes, no test containers. Point it at any running
instance (local dev, the deployed Hetzner box) via `BASE_URL`.

Uses Node's built-in test runner (`node:test`) and the global `fetch` /
`WebSocket`, so there is nothing to `npm install`. The global `WebSocket`
client `live-feed.test.js` uses needs **Node 22+** (earlier versions either
don't have it or need an experimental flag).

## Run it

Node's test runner resolves a bare directory argument as a module to
`require`, not a directory to search — so don't pass `blackbox-tests` as a
path. Either run from inside the directory with no path argument, or glob
explicitly from the repo root:

```bash
# from inside blackbox-tests/ (what `npm test` does)
cd blackbox-tests
BASE_URL=http://localhost:8080 node --test

# from the repo root
BASE_URL=http://localhost:8080 node --test 'blackbox-tests/**/*.test.js'

# BASE_URL defaults to http://localhost:8080 if omitted
node --test
```

Run a single file the same way — a specific file path (unlike a bare
directory) works from anywhere:

```bash
BASE_URL=http://localhost:8080 node --test blackbox-tests/flights-live.test.js
```

## Running against the real jar

There's one process and one port now — no nginx, no separate frontend
container, nothing to proxy through. Build and run the jar (optionally
with the frontend bundled in, `-Pwith-frontend`), then point `BASE_URL` at
it directly:

```bash
cd frontend && npm ci && npm run build   # required first — see note below
cd ../backend && mvn -B package -Pwith-frontend -DskipTests
java -jar target/flight-tracker.jar &
BASE_URL=http://localhost:8080 node --test 'blackbox-tests/**/*.test.js'
```

**`npm run build` must run first.** The `with-frontend` Maven profile only
*copies* an already-built `frontend/dist` into the jar — it doesn't build
the frontend itself. Skipping this step doesn't error; it silently produces
a jar with no `static/` entries at all, and `GET /` 404s. CI
(`build-deploy.yml`) always builds the frontend before the backend, so this
only bites a local repro of "the one true jar."

This is exactly what `build-deploy.yml`'s `blackbox` CI job does. There's
no longer a reason to test through a proxy vs. direct — the jar serves the
API, WebSocket and SPA on the same port either way.

## What's covered

- `flights-live.test.js` — `GET /api/flights/live`: response shape, that
  every returned position is airborne or within the landed-visibility
  window, and — tracking is global now — that a bbox actually scopes the
  result down to it while the bbox-less form returns at least as much.
- `flights-history.test.js` — `GET /api/flights/{icao24}/history`: response
  shape, required `from`/`to` params, unknown aircraft, invalid time range.
- `usage.test.js` — `GET /api/usage`: response shape, required `from`/`to`
  params, the window rules (`to` after `from`, at most 24 h, so 72 h is a
  400), derived-field sanity (non-negative distance/hours/speed).
- `error-bodies.test.js` — the app's error responses (404/405/400/500):
  each carries a single generic `error` field and no framework name, container
  name or version in the body or headers, and a request the container itself
  rejects (a malformed URI) answers with an empty body, not Tomcat's own error
  page.
- `health-sweep.test.js` — the health contract: `GET /api/health`'s
  `status`/`version`/`db` and its sweep-freshness trio
  (`lastSweepAt`, `lastSweepRows`, `skippedSweeps`), and
  `GET /api/health/sweep`'s 200-or-503 shape (never an HTML error page).
  The agreement between the sweep check and the freshness fields needs a
  productive global sweep to have landed, so that case waits for one (after
  reopening the poll window and polling `/api/health`), and the file itself
  reaches no external source. Against a jar with no reachable data source
  (`lastSweepAt` stays null) there is nothing to agree about: the case is
  skipped with its reason instead of passing on a branch that never ran.
- `live-feed.test.js` — `GET /ws/live`: WebSocket upgrade succeeds, the
  connection stays open, and any frames received parse as JSON matching the
  `FlightPosition` shape. Traffic is real and external (OpenSky), so this
  suite treats "no frame within the wait window" as inconclusive rather
  than a failure — see the comment in that file.
- `fake-oidc.test.js` — the self-test for `support/fake-oidc.js`, the hermetic
  fake OIDC provider the social-login black-box tests drive a real login
  through. Unlike the rest of this folder it needs **no jar and no `BASE_URL`**:
  it stands the provider up on loopback, walks discovery → JWKS → authorize →
  token, verifies the `id_token` with `node:crypto`, and checks that a defect
  mode and a tampered PKCE verifier are rejected. The provider is the JS twin
  of `backend/src/test/java/com/flighttracker/config/FakeOidcProvider.java`.
- `social-login.test.js` — optional social login (`flighttracker.profile.enabled=true`)
  over HTTP alone: the happy-path round trip through the fake provider, sign-out
  (`POST /api/auth/logout` is a 403 without the CSRF token the SPA echoes back and
  a 204 that clears the session with it), and every rejected login its own case
  (tampered `state`, wrong nonce, issuer, audience, expired token, unknown signing
  key) landing on the same relative `/?error` redirect with nobody signed in. It
  also pins `POST /api/health` at 405 on the flag-on chain, so the scoped CSRF rule
  cannot leak onto a route the feature does not own.

## The social-login tests

`social-login.test.js` never uses `BASE_URL`. It starts its **own** jar
(`support/login-app.js`) with the profile flag on and its Google registration
pointed at the suite's hermetic **fake OIDC provider** (`support/fake-oidc.js`),
which mints `id_token`s with a throwaway keypair on loopback — no Google, no npm
dependency, and the shared jar on 8080 is left alone. The fake's `mode` (and its
request log) is reset between cases, and one jar is booted once for the whole
file, so a run costs a single boot rather than one per case. It needs a jar of
*this* tree — `$FT_JAR`, `dist/flight-tracker.jar` (what CI downloads) or
`backend/target/flight-tracker.jar`; without one the file **skips with a reason**
locally, and **fails on CI**, where a missing artifact is the bug.

## What this suite deliberately does not do

It never touches the database, Spring context, or Java classes directly —
that's the point of "black box". Anything about *how* a response was
produced (which agent wrote a row, retry/backoff behaviour, SQL query
shape) belongs in backend unit/integration tests, not here.
