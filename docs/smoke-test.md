# Production smoke test

`scripts/smoke-prod.sh` answers one question after a deploy: **is the box that
just went live actually serving?** It is the check that runs *after* the
pipeline's own gate — `deploy.sh` already proved the new SHA is what
`127.0.0.1:8080` reports, on the box; this script proves the same thing from
outside, through Cloudflare, with the parts a health endpoint cannot see: live
traffic data, the WebSocket feed and the front page.

Run it after every deploy, and in the daily check-in.

## What it checks

| # | Check | Fails when |
|---|-------|-----------|
| 1 | `GET /api/health` | status or db is not `UP`; `version` is not the SHA you expect (or, with no SHA given, is not a 40-char git SHA — i.e. the build-info goal did not run) |
| 2 | `GET /api/flights/live/overview?...` | not JSON with `planes`/`clusters` arrays; a plane carries an out-of-range position; the active count for the box falls outside `SMOKE_MIN_ACTIVE..SMOKE_MAX_ACTIVE` |
| 3 | `GET /api/flights/live?...` | not a JSON array; a row carries an out-of-range position; the row count falls outside `SMOKE_MIN_LIVE..SMOKE_MAX_LIVE` |
| 4 | the front page in Playwright | the page does not answer, renders no map canvas, or logs any `console.error` / uncaught exception |
| 5 | `wss://…/ws/live` | no `LiveFrame` arrives within `SMOKE_WS_TIMEOUT` seconds, or the frame is not a plausible `LiveFrame` |

Checks 2 and 3 run against the Baltic/Stockholm box the app itself falls back
to (`latMin=54, latMax=66, lonMin=10, lonMax=25` — `ViewportService.DEFAULT`),
so "plausible" means "there is real traffic where the map opens", not a
hard-coded row count.

The summary line printed at the end looks like this:

```
smoke-prod: https://flight.pastabake.cloud (expected sha: 192eecc…)
PASS health: status=UP db=UP version=192eecc…
PASS overview: planes=41 clusters=0 active=41 (latMin=54&latMax=66&lonMin=10&lonMax=25)
PASS live: rows=640 (latMin=54&latMax=66&lonMin=10&lonMax=25)
PASS front page: HTTP 200 title='Netwatch Skygrid' canvas=1 console errors=0
PASS websocket: LiveFrame after 3606ms: {"icao24":"8015f7","callsign":"AIC71A",…}
smoke-prod: PASS — https://flight.pastabake.cloud healthy in 22s
```

## Running it

```bash
scripts/smoke-prod.sh <40-char-sha>        # after a deploy: pin the expected SHA
GITHUB_SHA=<sha> scripts/smoke-prod.sh     # same, from the environment
scripts/smoke-prod.sh                      # daily check-in: any 40-char SHA
scripts/smoke-prod.sh --url http://127.0.0.1:8080 --timeout 20   # against a local build
```

Options: `--url`, `--sha`, `--timeout`, `-h`. A bare positional argument is the
expected SHA.

Environment overrides (all optional): `SMOKE_BASE_URL`/`BASE_URL`,
`SMOKE_EXPECTED_SHA`/`GITHUB_SHA`, `SMOKE_BBOX=latMin,latMax,lonMin,lonMax`,
`SMOKE_WS_TIMEOUT` (default 30), `SMOKE_HTTP_TIMEOUT` (default 10),
`SMOKE_PAGE_SETTLE_MS` (default 7000), `SMOKE_MIN_ACTIVE`/`SMOKE_MAX_ACTIVE`
(default 1/20000), `SMOKE_MIN_LIVE`/`SMOKE_MAX_LIVE` (default 1/100000),
`PW_CHROMIUM_PATH`, `NODE_PATH`/`SMOKE_NODE_PATH`.

**Exit codes:** `0` every check passed · `1` one or more checks failed, one
line per failure on stdout · `2` bad usage (unknown flag, a SHA that is not 40
hex chars, a malformed `SMOKE_BBOX`). A healthy run takes roughly 25–50 s.

## What it needs

`curl`, `jq`, and `node` 22 or newer (for the WebSocket client and Playwright —
`WebSocket` is a Node global from 22). Playwright's `playwright` module must be
resolvable; the script tries `frontend/node_modules`, `node_modules`,
`NODE_PATH`/`SMOKE_NODE_PATH` and the global npm root, in that order. Chromium
comes from Playwright's own download unless `PW_CHROMIUM_PATH` points at one
(the cloud image sets `PW_CHROMIUM_PATH=/opt/pw-browsers/chromium`; a VPS agent
sandbox without it has only Playwright's headless shell under
`PLAYWRIGHT_BROWSERS_PATH`, and pointing `PW_CHROMIUM_PATH` at that binary works
the same way — see docs/cloud-agents.md).

## Why the front page is checked before the WebSocket

The live feed has nothing to push on its own: `LiveFeedBroadcaster` only emits
on a `PositionsPersistedEvent`, which is published by the *hot* poll
(`PositionPersistenceService.persist`), and the hot poll only runs while the
backend's poll window is open. The window is opened by the front page —
`FlightMap.tsx` calls `POST /api/agents/restart` on mount when it is closed — or
by someone else watching. That is why the script loads the front page first,
then reports the Stockholm box to `/api/flights/live` and waits on the socket:
by then the window the feed rides on is open.

Consequence worth knowing: the window is a shared, quota-limited resource
(3 restarts per 15 minutes, plus per-IP budgets — see `PollWindowService`, the
`rate-limit` block in `backend/src/main/resources/application.yml`). If the
quota is already spent — many runs in a quarter of an hour, or a burst of real
visitors — the page load cannot reopen it, the feed genuinely pushes nothing,
and check 5 fails. That is not a broken deploy, and the failure line says so:
it quotes `/api/agents/status`, so `active=false` reads as "poll window closed,
not pushed" rather than as a dead app. One run per deploy and one per daily
check-in stay well inside the quota.

## What it deliberately does not do

- **No writes.** Every request is a GET; nothing is restarted, rolled back or
  reconfigured. (Loading the front page is what triggers the app's own
  `POST /api/agents/restart` — the same call any visitor's browser makes — and
  that is the only state change the run causes.)
- **No rollback.** A failed check exits non-zero and prints why; the decision
  and the rollback (`deploy/hetzner/README.md`) stay with the operator.
- **Not a CI gate.** Deploys already gate on `deploy.sh`'s own health check.
  This is the after-the-fact, outside-in check.
