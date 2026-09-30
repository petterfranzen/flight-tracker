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
cd backend && mvn -B package -Pwith-frontend -DskipTests
java -jar target/flight-tracker.jar &
BASE_URL=http://localhost:8080 node --test 'blackbox-tests/**/*.test.js'
```

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
  params, derived-field sanity (non-negative distance/hours/speed).
- `live-feed.test.js` — `GET /ws/live`: WebSocket upgrade succeeds, the
  connection stays open, and any frames received parse as JSON matching the
  `FlightPosition` shape. Traffic is real and external (OpenSky), so this
  suite treats "no frame within the wait window" as inconclusive rather
  than a failure — see the comment in that file.

## What this suite deliberately does not do

It never touches the database, Spring context, or Java classes directly —
that's the point of "black box". Anything about *how* a response was
produced (which agent wrote a row, retry/backoff behaviour, SQL query
shape) belongs in backend unit/integration tests, not here.
