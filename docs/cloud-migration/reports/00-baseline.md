# Phase 0: baseline (orchestrator)

Run against untouched `main` content on branch `feat/cloud-migration`
(bundle-only commit, no application code touched yet), 2026-09-30.

**Environment note:** this machine had no `mvn`/`node`/`docker`/etc. on PATH
and Homebrew couldn't build some deps from source. See
`docs/cloud-migration/reports/STATUS.md` for the toolchain that was set up
(binary installs under `~/.local/toolchains/`, sourced via `env.sh`) and
**Docker Desktop was replaced with Colima + containerd + nerdctl** — every
`docker`/`docker compose` command below actually ran as
`colima nerdctl -- ...` / `colima nerdctl -- compose ...`. Subagents need the
same substitution; noted in each spawn prompt.

## 1. `mvn -B verify` (backend)
**PASS.** `BUILD SUCCESS`, 7.6s. 40/40 tests, 0 failures/errors/skipped
(`PhaseLoggerTest`, `FlightControllerTest`, `EstimatorAgentTest`,
`FlightPhaseClassifierTest`, `EstimatedPositionServiceTest`).

## 2. Frontend: `npm ci && npm run build`
**PASS.** Build clean, `tsc -b` strict. Bundle sizes (raw / gzip):

| Asset | Raw | Gzip |
|---|---:|---:|
| `MaplibreBasemap-*.js` | 975,251 B | 258,701 B |
| `maplibre-gl-worker-*.js` | 487,108 B | 138,107 B |
| `index-*.js` | 336,614 B | 102,645 B |
| `DefaultAirports-*.js` | 62,144 B | 23,828 B |
| `MaplibreBasemap-*.css` | 83,060 B | 10,606 B |
| `index-*.css` | 42,188 B | 11,260 B |
| `DefaultAirports-*.css` | 519 B | 326 B |

This is the number B1 (frontend-vanilla) compares against — target from
PLAN §6 B1.7: app JS excluding the MapLibre chunk ≤ 60 KB gzip. Baseline
app JS (`index-*.js` + `DefaultAirports-*.js`) = 126,473 B gzip.

## 3. `npx playwright install chromium && npm run test:e2e`
**PASS.** 17/17 passed, 47.7s. (Console `ECONNREFUSED` proxy-error lines in
the log are expected — these specs run against Vite's dev server with no
backend attached, using fixtures/mocks, not the compose stack.)

## 4. `colima nerdctl -- compose up -d --build` + blackbox suite
**PASS**, with one substitution from the plan's literal command:
- `nerdctl compose` has no `--wait` flag (unlike `docker compose`) — polled
  `/api/flights/live` manually instead until 200 (ready in ~3s after
  container start).
- All 5 containers reached `running`; `backend-api` and `frontend`
  healthchecks green.
- `BASE_URL=http://localhost:5173 node --test 'blackbox-tests/**/*.test.js'`:
  **16/16 passed**, 5.8s (includes a live `/ws/live` WebSocket upgrade test
  and a real 20+ second `/api/usage` query).
- Anonymous OpenSky polling worked out of the box (no credentials set) —
  live flight data was flowing within seconds of startup.

## 5. Golden contract
Captured to `docs/cloud-migration/golden/` (large arrays trimmed to ~10-20
entries; full field/type contract in `docs/cloud-migration/golden/SHAPES.md`,
which is what gates actually diff against):
`live.json`, `live-bbox.json`, `clusters.json`, `count.json`, `status.json`,
`airport-info.json` (code=`ARN`, not `ESSA` — the endpoint keys by IATA, see
SHAPES.md), `aircraft-39de4f.json`, `history-39de4f.json`, `usage.json`
(`history`/`usage` both require `from`/`to` `Instant` query params — noted
in SHAPES.md since it's easy to miss).

## 6. Container memory after 5 minutes (`colima nerdctl -- stats --no-stream`)

| Service | Mem |
|---|---:|
| `backend-api` | 458.2 MiB |
| `backend-agent` | 307.1 MiB |
| `backend-estimator` | 302.7 MiB |
| `db` (Postgres) | 100.2 MiB |
| `frontend` (nginx) | 4.5 MiB |
| **3 JVMs combined** | **1,068.0 MiB** |

Baseline for A1's single-process target: the plan's systemd unit budgets
768 MB heap + ~300 MB JVM overhead (~1,068 MB) for **one** JVM — directly
comparable to the 1,068 MB **combined** across three JVMs today. Worth
re-checking RSS after A1/A2 land against this same 5-minute mark.

## Verdict
Everything green on untouched `main`. No 🔒 ASK needed — proceeding to spawn
A1 (backend-consolidator), B1 (frontend-vanilla), C1 (ci-deployer) per
PLAN §4.

Stack torn down after capture: `colima nerdctl -- compose down -v`.
