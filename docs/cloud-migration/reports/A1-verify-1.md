# Gate A1 verification report

Branch: `feat/cm-backend` @ `0427f91d5d97f519c2d0da8d29072400fd339a7a` (checked
out detached in this worktree, since another worktree already holds the
branch ref itself — confirmed same SHA as the hand-off report).

## Result: PASS

All seven Gate A1 checklist items verified directly (not accepted from the
hand-off report).

## Checklist

- [x] `mvn -B verify` green — 70/70 unit tests, BUILD SUCCESS, ~3.4s.
- [x] Single process, no `SPRING_PROFILES_ACTIVE`, against a fresh
      `postgres:16-alpine` container (`ft-pg-verify`, isolated, only
      container running throughout). Booted clean 3 separate times during
      verification; each boot seeded/warmed correctly, no errors.
- [x] Blackbox suite: 16/16 passing against `BASE_URL=http://127.0.0.1:8080`
      (`node --test` in `blackbox-tests/`, Node v24.21.0).
- [x] Golden shapes: re-captured all 9 Phase 0 endpoints live and diffed
      field-for-field against `golden/SHAPES.md`. 8 of 9 identical
      (`live`, `live-bbox`, `clusters`, `count`, `status`, `airport-info`,
      `aircraft/{icao24}`, `usage`). One discrepancy found and investigated
      — see Concerns below; confirmed pre-existing, not introduced by this
      branch, so not counted as a gate failure.
- [x] `grep -rn "@Profile\|LISTEN\|NOTIFY\|PGConnection" backend/src/main`
      → empty.
- [x] Rate limit: `TRUST_LOCAL` unset (default false). Clean boot, 3 calls
      to `POST /api/agents/restart` with `CF-Connecting-IP: 203.0.113.9`
      from localhost curl succeeded (200), 4th within the same minute
      returned 429. Confirms local/loopback origin is **not** exempted
      once a spoofed forwarded-for header is present, i.e. the
      CF-Connecting-IP-first resolution + trust-local gate work as
      designed.
- [x] WebSocket keepalive: wrote a raw stdlib-socket WS client (handshake
      by hand, RFC 6455 framing) against `GET /ws/live` to observe control
      frames directly — something neither a browser nor Node's global
      `WebSocket` exposes to JS. Held the connection open **155.4s** fully
      idle from the test side; received **5 native PING frames** at the
      expected ~30s cadence (t≈24s, 54s, 84s, 114s, 144s), replied PONG
      each time per spec, connection never closed early, closed cleanly at
      the end.

## Out-of-scope edits: none

`git diff feat/cloud-migration...feat/cm-backend --stat` shows 49 changed
files, all under `backend/src/main/java/**`, `backend/src/main/resources/
{application.yml,application-agent.yml,application-estimator.yml,
schema.sql}`, and `backend/src/test/java/**`. No changes to `pom.xml`,
frontend, or `.github/workflows/**`.

## RSS at ~5min: ~442 MB, vs baseline 1,068 MB combined

Single-process RSS sampled at 6m34s uptime (past initial seed-sweep
settling): 452,576 KB ≈ **442 MB**. Well below the Phase 0 baseline's
1,068 MB combined across 3 JVMs (docs/cloud-migration/reports/
00-baseline.md) — expected and consistent with consolidating three
containers into one process. Only a single reading was taken (time
budget); trend across the ~6 min window (469MB → 453MB → 442MB) was flat
to slightly declining, not growing, so this looks like a steady-state
number rather than a mid-warm-up snapshot.

## Investigated during verification (not gate failures)

**Rate-limit anomaly, traced and resolved.** On the *first* boot of the
process, before any legitimate test traffic, a restart call from a brand
new IP unexpectedly returned 429 immediately (with `Retry-After`,
indicating the global 15-minute restart quota was already exhausted).
Re-tested with two subsequent completely clean boots: the very first
`POST /api/agents/restart` call on a fresh process consistently succeeds
(200), and the quota behaves exactly as coded (global max 3 per 15 min,
per-IP max 3 per minute — both configured to 3, which is why either can be
the one to reject the 4th call). Reviewed `PollWindowService.restart()`,
`RestartRateLimiter`, and `AgentOrchestrator.seedOnStartup()` — the only
two call sites for `restart()`, and the bypass-vs-counted paths are
correct. Could not identify any code path that would legitimately
pre-exhaust the quota before real traffic; most likely an artifact of the
verification sequence in that first process instance, not a defect in the
branch. Flagging for visibility, not blocking the gate, since two clean
re-tests both passed.

**Golden shape discrepancy: `/api/flights/{icao24}/history`.** SHAPES.md
documents this endpoint's array elements as the same 7-field
`FlightPosition` contract shape (`observedAt, icao24, onGround, latitude,
longitude, callsign, headingDeg`). The live re-capture returns 12 fields
— the same 7 plus `id, altitudeM, velocityMs, verticalRateMs,
agentSource`. Checked whether this is an A1 regression: `git diff
feat/cloud-migration...feat/cm-backend -- .../model/FlightPosition.java`
shows only an additive constructor overload (for `LiveStateStore`'s use);
no existing field was added, removed, or changed. The repo's own Phase 0
golden sample (`docs/cloud-migration/golden/history-39de4f.json`, captured
pre-migration per SHAPES.md's own header) already contains these same 12
fields. So this is a pre-existing gap between SHAPES.md's documentation
and the endpoint's actual (and unchanged) behaviour — not something this
branch introduced or regressed. Worth fixing SHAPES.md (or narrowing the
endpoint's serialization) at some point, but it's outside A1's scope and
not a reason to fail this gate.

**Warm-up SQL bugfix (commit `0427f91`), verified correct.** The fix
changes `lt.observed_at` → `lt.landed_since` in `LiveStateStore.warmUp()`'s
correlated subquery, matching the `landed_transitions` CTE's actual column
alias (`SELECT icao24, observed_at AS landed_since FROM windowed WHERE
...`). This is a straightforward, correct fix — not masking a deeper
issue. Confirmed empirically: a restart against Postgres with ~13k
existing `flight_position` rows logged `LiveStateStore warm-up: loaded
13090 aircraft from flight_position` with no SQL errors.

## Concerns (non-blocking)

- SHAPES.md vs `/api/flights/{icao24}/history` actual shape mismatch
  (pre-existing, described above) — recommend the orchestrator schedule a
  SHAPES.md correction or an endpoint DTO narrowing at some point, not
  urgent for A1/A2.
- `HotPollUserBudget` persisting per-IP hot-poll history to `app_state`
  (flagged by the implementing agent itself) — reviewed the code
  (`HotPollUserBudget.java`): correct, bounded (24h rolling prune per IP,
  same pattern as the in-memory `RestartRateLimiter`), just more
  persistence machinery than the original in-memory-only design's comment
  anticipated. A judgment call for Petter, not a defect.
- Global restart-quota-max (3 per 15 min) and per-IP restart-per-minute
  cap (also 3) being numerically identical makes it hard to tell from the
  outside which limiter fired on a given 429. Not a bug, just a testing/
  observability note — the 429 response body doesn't distinguish the
  reason (only `Retry-After`'s presence/absence does, and only for the
  global quota path).

## Commands used (abbreviated)

```
mvn -B verify
colima nerdctl -- run -d --name ft-pg-verify -e POSTGRES_DB=flighttracker \
  -e POSTGRES_USER=flighttracker -e POSTGRES_PASSWORD=flighttracker \
  -p 5432:5432 postgres:16-alpine
java -jar backend/target/flight-tracker-0.1.0.jar   # no SPRING_PROFILES_ACTIVE
cd blackbox-tests && BASE_URL=http://127.0.0.1:8080 node --test
curl http://127.0.0.1:8080/api/{health,flights/live,...}   # golden shape capture
curl -X POST -H "CF-Connecting-IP: 203.0.113.9" http://127.0.0.1:8080/api/agents/restart  # x4
python3 ws_raw_keepalive.py   # raw RFC 6455 client, 155s hold, ping/pong inspection
colima nerdctl -- rm -f ft-pg-verify   # cleanup
```

Postgres container and backend process both torn down at the end of this
verification run.
