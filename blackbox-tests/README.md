# Black-box API test suite

Exercises the flight-tracker backend purely over HTTP/WebSocket — no JVM,
no repository classes, no test containers. Point it at any running
instance (local, docker-compose, staging) via `BASE_URL`.

Uses Node's built-in test runner (`node:test`) and the global `fetch` /
`WebSocket`, so there is nothing to `npm install` — any Node 20+ works.

## Run it

```bash
# against a local backend on the default port
BASE_URL=http://localhost:8080 node --test blackbox-tests

# against any other deployment
BASE_URL=https://flight-tracker.example.com node --test blackbox-tests

# BASE_URL defaults to http://localhost:8080 if omitted
node --test blackbox-tests
```

Run a single file the same way:

```bash
BASE_URL=http://localhost:8080 node --test blackbox-tests/flights-live.test.js
```

## What's covered

- `flights-live.test.js` — `GET /api/flights/live`: response shape, default
  and explicit `withinMinutes`, invalid query param handling.
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
