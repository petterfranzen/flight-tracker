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
| 5 | response headers on `/` and `/api/health` | any of `Content-Security-Policy` (or `Content-Security-Policy-Report-Only` when the roll-back is on), `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy` is missing from either path |
| 6 | `wss://…/ws/live` with `Origin: <the site>` | the handshake does not answer `101`, no `LiveFrame` arrives within `SMOKE_WS_TIMEOUT` seconds, or the frame is not a plausible `LiveFrame` |
| 7 | `wss://…/ws/live` with `Origin: https://evil.example` | the handshake does not answer `403` — i.e. the `Origin` allow-list is not rejecting a foreign site |

Checks 2 and 3 run against the Baltic/Stockholm box the app itself falls back
to (`latMin=54, latMax=66, lonMin=10, lonMax=25` — `ViewportService.DEFAULT`),
so "plausible" means "there is real traffic where the map opens", not a
hard-coded row count.

The summary line printed at the end looks like this:

```
smoke-prod: https://flight.pastabake.cloud (expected sha: 192eecc…)
PASS health: status=UP db=UP version=192eecc…
PASS headers: / has Content-Security-Policy, X-Content-Type-Options, Referrer-Policy, Permissions-Policy
PASS headers: /api/health has Content-Security-Policy, X-Content-Type-Options, Referrer-Policy, Permissions-Policy
PASS overview: planes=41 clusters=0 active=41 (latMin=54&latMax=66&lonMin=10&lonMax=25)
PASS live: rows=640 (latMin=54&latMax=66&lonMin=10&lonMax=25)
PASS front page: HTTP 200 title='Netwatch Skygrid' canvas=1 console errors=0
PASS websocket: 101 with Origin https://flight.pastabake.cloud, LiveFrame after 3606ms: {"icao24":"8015f7",…}
PASS websocket: 403 for Origin https://evil.example
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
`SMOKE_CSP_REPORT_ONLY` (default `false` — see the roll-back section below),
`SMOKE_WS_ORIGIN` (default: the origin of `--url`, i.e. the public site),
`SMOKE_WS_BAD_ORIGIN` (default `https://evil.example`),
`PW_CHROMIUM_PATH`, `NODE_PATH`/`SMOKE_NODE_PATH`.

**Exit codes:** `0` every check passed · `1` one or more checks failed, one
line per failure on stdout · `2` bad usage (unknown flag, a SHA that is not 40
hex chars, a malformed `SMOKE_BBOX`). A healthy run takes roughly 25–50 s.

## The same checks against a local jar

`blackbox-tests/security-headers.test.js` makes the same assertions without a
deploy: the four headers on `/` and `/api/health`, `101` plus (when there is
traffic) a first `LiveFrame` for the public site's `Origin`, and `403` for a
foreign one. CI's `blackbox` job runs it against the jar that `deploy` ships,
so the assertions are proven against a known-good build before this script
ever runs at production. Locally:

```bash
BASE_URL=http://127.0.0.1:8080 node --test blackbox-tests/security-headers.test.js
```

## Rolling back

Both the CSP and the `Origin` allow-list have a switch that takes effect on
the next deploy, without a code change. Change the value in the box's
environment, redeploy/restart, then run this script again — it reports which
state it found, so a half-applied roll-back is visible rather than silent.

- **CSP is breaking something** (a blocked script, style or connection the
  policy did not anticipate): set `FLIGHTTRACKER_CSP_REPORT_ONLY=true`. The
  policy then ships as `Content-Security-Policy-Report-Only` — reported, not
  enforced — and this script must be run with `SMOKE_CSP_REPORT_ONLY=true` so
  it expects that header instead. Revert by setting it back to `false`.
  On a live box the usual cause is a third-party origin missing from
  `connect-src`/`img-src`; the browser console names the blocked URI.
- **The live feed stops connecting** after a deploy or a hostname change: the
  browser's `Origin` is not on `flighttracker.ws.allowed-origins`
  (`FLIGHTTRACKER_WS_ALLOWED_ORIGINS`, comma-separated full origins —
  `scheme://host[:port]`, no paths, no wildcards; a `*` entry is ignored by
  design). Add the public origin, redeploy, and re-run this script: check 6
  answering something other than `101` for `Origin: <the site>` is this
  misconfiguration, and check 7 turning into a `101` means the allow-list was
  emptied or bypassed. Revert by removing the origin again.

Neither switch needs a Cloudflare or deploy-key change: both are read from the
service's own environment — `/etc/flight-tracker/env`, the systemd unit's
`EnvironmentFile` (see `deploy/hetzner/README.md`) — so they roll back on the
next restart without touching the tunnel, the origin or the deploy key.

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
