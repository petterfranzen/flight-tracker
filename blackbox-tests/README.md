# Black-box API test suite

Exercises the flight-tracker system purely over HTTP/WebSocket — no JVM,
no repository classes, no test containers. Point it at any running
instance (local backend, the full docker-compose stack, staging) via
`BASE_URL`.

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

## Running against the docker-compose stack

`docker-compose.yml` at the repo root brings up four containers — `db`
(Postgres), `backend-api` (Spring Boot REST + WebSocket), `backend-agent`
(the headless OpenSky poller — see its own `@Profile("agent")`, no HTTP
port of its own), and `frontend` (nginx serving the built SPA and proxying
`/api` and `/ws` to `backend-api`). To black-box test the *whole* stack as
a real client would hit it — through nginx, not straight to the JVM —
point `BASE_URL` at the frontend's published port rather than
`backend-api`'s:

```bash
docker compose up --build -d
BASE_URL=http://localhost:5173 node --test 'blackbox-tests/**/*.test.js'
```

This exercises nginx's `/api`/`/ws` proxy rules, `backend-api`'s
controllers and WebSocket handler, `backend-agent` (indirectly — it's the
one actually writing the positions these tests read), and Postgres
underneath. Pointing `BASE_URL` at `http://localhost:8080` instead talks to
`backend-api` directly, skipping the nginx hop — useful for isolating
whether a failure is in the proxy config or the app itself.

## What's covered

- `flights-live.test.js` — `GET /api/flights/live`: response shape, and that
  every returned position is airborne or within the landed-visibility window.
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
