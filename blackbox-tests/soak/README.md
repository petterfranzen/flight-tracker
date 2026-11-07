# Live-feed soak and load test

A production-size soak test for `GET /ws/live`: thousands of synthetic
aircraft, many simultaneous WebSocket clients, sustained for as long as you
point it at, with frame latency and JVM memory reported at the end. It is a
separate, manual/nightly job on purpose — it is long and CPU-hungry and must
never sit in the PR gate.

The app under test is the real, unmodified jar. The only thing faked is the
upstream data source (`mock-opensky.mjs`), which speaks OpenSky's
`/states/all` JSON so `OpenSkyAgent` cannot tell the difference. The wire
format, the poll window, `persist()`, the commit-gated event, the viewport
filter and `LiveFeedBroadcaster` all run for real.

## Requirements

- Node 22+ (the suite already needs the global `WebSocket` client; CI uses 24).
- Java 21.
- A built jar at `backend/target/flight-tracker.jar`:

```bash
cd backend && mvn -B package -DskipTests
```

No `npm install`: both scripts use only the Node standard library.

## Quick smoke (about 2 minutes, laptop-sized)

```bash
SOAK_DURATION_SECONDS=90 SOAK_WARMUP_SECONDS=20 \
SOAK_AIRCRAFT=2000 SOAK_CLIENTS=10 SOAK_POLL_SECONDS=2 \
node blackbox-tests/soak/soak.mjs
```

It starts the synthetic source and the jar, seeds an empty database through
the app's own global sweep, opens the poll window, connects the clients and
writes `soak-report.json` in the working directory. The jar's log is copied to
`soak-app.log` next to the report; the temporary database is deleted at the end
unless `SOAK_KEEP_DB=1` (which keeps the whole run directory, DB included).

## Production-size run

```bash
SOAK_DURATION_SECONDS=3600 \
SOAK_CLIENTS=200 \
SOAK_AIRCRAFT=12000 \
node blackbox-tests/soak/soak.mjs
```

Defaults: 12,000 aircraft (roughly OpenSky's worldwide live set), 100 clients,
production's 18 s hot-poll cadence and 360 s global sweep, a 10 x 15 degree
continent-scale viewport in dense Europe (~650 aircraft in view, which is what
the WebSocket fan-out actually multiplies), 15 minutes duration, 90 s warm-up.
Scale clients up on a bigger box; each client is an independent WebSocket
connection, as a browser tab would be.

Drop `SOAK_POLL_SECONDS` to push harder: at 5 s the same viewport is a
continuous ~130 frames/s per client rather than an 18 s burst, which is well
past production and will saturate a small box.

## Running clients against an already-running instance

`SOAK_MODE=external` skips the jar and the synthetic source and only drives
clients against `SOAK_BASE_URL`. Use it to load a staging or production
deployment. Server RSS/CPU are not sampled in this mode (no `/proc` access to a
remote PID), so only latency and delivery are reported. Point the server at a
synthetic source yourself first if you want deterministic counts.

```bash
SOAK_MODE=external SOAK_BASE_URL=https://staging.example \
SOAK_CLIENTS=500 SOAK_DURATION_SECONDS=1800 \
node blackbox-tests/soak/soak.mjs
```

## Configuration

All settings are environment variables; `soak.mjs` prints the effective set in
the report's `config` block.

| Variable | Default | Meaning |
| --- | --- | --- |
| `SOAK_MODE` | `local` | `local` starts jar + synthetic source; `external` drives clients only |
| `SOAK_BASE_URL` | `http://127.0.0.1:18080` | Base URL in external mode |
| `SOAK_JAR` | `backend/target/flight-tracker.jar` | Jar to run in local mode; a relative path is resolved against the repo root, not the cwd |
| `SOAK_PORT` | `18080` | App port in local mode |
| `SOAK_MOCK_PORT` | `18099` | Synthetic OpenSky port |
| `SOAK_AIRCRAFT` | `12000` | Synthetic worldwide aircraft count |
| `SOAK_CLIENTS` | `100` | Concurrent WebSocket connections |
| `SOAK_POLL_SECONDS` | `18` | Hot-poll cadence (`poll-interval-seconds`), production's default |
| `SOAK_GLOBAL_SWEEP_SECONDS` | `360` | Global-sweep cadence (`global-sweep-interval-seconds`), production's default |
| `SOAK_DURATION_SECONDS` | `900` | Steady-state measurement window |
| `SOAK_WARMUP_SECONDS` | `90` | Connection settle time; frames here are counted but not in latency stats |
| `SOAK_START_TIMEOUT_SECONDS` | `300` | Health wait (empty-DB seed runs a full sweep first) |
| `SOAK_STOP_TIMEOUT_SECONDS` | `25` | Graceful shutdown wait |
| `SOAK_RSS_SAMPLE_MS` | `5000` | `/proc` sampling interval |
| `SOAK_VIEW_LAT_MIN` / `_MAX` | `45` / `55` | Reported viewport |
| `SOAK_VIEW_LON_MIN` / `_MAX` | `5` / `20` | Reported viewport |
| `SOAK_JAVA` | `java` (or `$JAVA_HOME/bin/java` when set) | Java 21 binary to run the jar with |
| `SOAK_XMX` | `1g` | JVM heap |
| `SOAK_MAX_P95_MS` | `0` (off) | Fail if p95 frame age exceeds this |
| `SOAK_MAX_RSS_MB` | `0` (off) | Fail if peak RSS exceeds this |
| `SOAK_MIN_DELIVERY_RATIO` | `0` (off) | Fail if delivery ratio falls below this |
| `SOAK_KEEP_DB` | `0` | `1` keeps the temp DB and app log |
| `SOAK_OUT` | `soak-report.json` | Report path |
| `SOAK_APP_LOG` | `soak-app.log` | Where the jar's log is copied when the run ends |

Thresholds default to off so a nightly run reports rather than flakes. Set
them once you know the box's baseline (see "Reading the report").

## What it measures

- **Frame age at the client** (`latencyMs`): `Date.now() - observedAt` for every
  frame received during steady state. `LiveFrame` has no server-send timestamp
  and the wire format is frozen, so this is the honest end-to-end freshness:
  upstream observation -> poll -> persist -> commit -> broadcast -> socket ->
  client parse. In local mode the synthetic source stamps `observedAt=now`, so
  nearly all of the age is this app's own path. In external mode it also
  includes OpenSky's own `last_contact` staleness. Percentiles are from 1 ms
  buckets; `maxMs` is exact.
- **Delivery ratio** (`delivery.ratio`): frames received by all clients divided
  by the synthetic states the source returned in the viewport during steady
  state times the client count. A value near 1.0 means every broadcast reached
  every client. Below ~0.9 means frames were dropped (`ConcurrentWebSocketSessionDecorator`'s
  bounded buffer drops oldest first for a slow client) or clients fell behind.
- **Close codes** (`clients.closeCodes`): `1011` is the server closing a client
  that could not drain within 10 s; `1000`/`1001` are clean/going-away; `1006`
  is an abnormal drop. A rising 1011 count is the server shedding load.
- **Server memory** (`server.rssMb`): RSS at steady-state start and end, peak,
  peak `VmHWM`, and growth. Growth across an hour is the leak signal; a peak
  near `-Xmx` plus native memory is the headroom signal. Local mode only.
- **Server CPU** (`server.cpuSeconds.used`): utime+stime during steady state,
  from `/proc/PID/stat` at 100 Hz.
- **Per-client frame counts and gaps**: min/median/max frames and mean/max gap
  between frames. A client whose count lags its peers is being starved or
  dropped.

The report is JSON (`soak-report.json`) plus a short stdout summary. The run
exits non-zero only on an app crash, zero frames, or a threshold breach.

## Why the "DB generator" is the synthetic source

The app seeds an empty database with a full global sweep in `@PostConstruct`
(`AgentOrchestrator.seedOnStartup`), and every hot poll afterwards runs the
real `PositionPersistenceService.persist()` path. Pointing the app at
`mock-opensky.mjs` therefore generates a production-size database through the
app's own write path: nothing writes SQLite out of band, and the invariant that
`flight_position` is append-only is exercised exactly as in production. That is
also why this stays a black-box test — the generator is an upstream HTTP source,
not a repository class.

Only `persist()` (the hot poll) publishes `PositionsPersistedEvent`, so only
hot-poll frames reach the WebSocket. The global sweep (`persistBatch`) fills the
database and the `/api/flights/live` initial paint but deliberately does not
broadcast; the soak's frame counts and latency therefore describe the hot-poll
fan-out path, which is the one production users actually see.

## Nightly workflow

`soak-workflow.yml` next to this README is the workflow body. It is kept out of
`.github/workflows/` in this PR because the sandbox's GitHub token cannot push
that path; the coordinator copies it to `.github/workflows/soak.yml`. It runs on
a nightly schedule and on `workflow_dispatch`, never on `pull_request`.

```bash
# after it is in place, from the Actions tab:
#   Soak test → Run workflow   (defaults: 15 min, 100 clients, 12k aircraft)
```

The workflow uploads `soak-report.json` and `soak-app.log` as artifacts on
every run. Its thresholds are commented out by default; set `SOAK_MAX_P95_MS` /
`SOAK_MAX_RSS_MB` in the workflow's `env:` once a baseline is established.

## Caveats

- Synthetic positions drift on gentle arcs, not real great-circle tracks. That
  is deliberate: it keeps every aircraft in its region for an hour, so the
  in-view count stays stable and latency numbers are comparable between runs.
  It is not a physics or track-quality test.
- One process serves every client the same shared viewport
  (`ViewportService`'s documented simplification). The soak therefore models
  "many viewers on one continent view", not many viewers on different views.
- Absolute numbers from a small sandbox are not production numbers. Use the
  ratios and growth slopes, and run the production-size command on a box with
  at least 2 vCPU and 2 GB free.
