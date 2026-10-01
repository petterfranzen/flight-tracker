# Gate A2 verification — sqlite-migrator

Branch: `feat/cm-backend` @ `bdb8ee6` (3 commits on top of A1's `0427f91`:
`828deec` migrate persistence to SQLite, `e32a467` SQLite integration
tests, `bdb8ee6` auto_vacuum fresh-boot fix). Verified by checking out this
exact commit (detached HEAD) in a worktree, since the branch itself was
already checked out elsewhere.

## Result: **PASS**

## Checklist

### Gate A1 items, re-verified against SQLite
- `mvn -B verify`: **green**, 72/72 tests (70 unit + 2 SQLite integration), `BUILD SUCCESS`, ~3.6s.
- Single process, no `SPRING_PROFILES_ACTIVE`, no other backend container: confirmed (`No active profile set, falling back to 1 default profile: "default"`; no Postgres/docker containers running — only an idle Colima VM daemon, no containers).
- Blackbox suite (`BASE_URL=http://127.0.0.1:8080`): **16/16 twice**.
- Golden shapes re-captured: **all match** `golden/SHAPES.md`, including `/history` — see important note below on which copy of SHAPES.md is authoritative.
- `grep -rn "@Profile\|LISTEN\|NOTIFY\|PGConnection" backend/src/main` → **empty**.
- `TRUST_LOCAL=false` + `CF-Connecting-IP` rate-limit test: **3 ok, 4th → 429** (tested cleanly on a fresh process to avoid the global `restart-quota-max` confound — see Concerns).
- WebSocket idle test: raw RFC-6455 client held the connection **164s** (≥150s), received **6 PING frames** (opcode 9) at ~30s cadence (t=14,44,74,104,134,164s).

### `grep -rni "postgres|jpa|hibernate" backend/`
Only comments/docs and one coincidental data match (`SBJP JPA Presidente
Castro Pinto...` in `airports.tsv`, an airport IATA code, not a hit).
**PASS.**

### 20-minute live run (real anonymous OpenSky)
Ran from 23:31:35 to 23:55:41 (~24 min). `/api/health/sweep` returned
**200** throughout, on every check. 5 "global sweep complete" events fired
on schedule (boot seed + 4 more at the 360s interval). Only the **boot
seed** carried data: `opensky: batched insert of 11313 rows took 68 ms`
(comfortably under the 2s budget). Every subsequent sweep returned 0 rows
because anonymous OpenSky throttled the app almost immediately
(`OpenSky throttled us (429)`, backoff escalating 30s→60s→120s→240s→300s
and staying at the 300s cap) — `PollBackoff` behaved exactly as designed
("degraded, not broken": sweep still runs and is still logged, just finds
nothing to insert). I believe this was compounded by my own verification
method: I ran a **second** app instance (the retention test, port 8081)
hot-polling OpenSky anonymously in parallel with the main app for about 4
minutes, which likely burned through the shared anonymous quota faster
than a single instance would have. The one real data point we have (68ms
for 11.3k rows) is well inside budget, and the scheduling/health-tracking
machinery itself is verified correct and reliable. **Not treating this as
a blocking failure** — see Concerns.

### Retention test (separate process, fresh DB, `retention.hours=0.05`)
Port 8081, `retention.interval-ms=30000`, `initial-delay-ms=5000`. Over 7
observed cycles: rows consistently aged out within one interval (e.g. a
9,852-row bulk deletion once the initial 11,323-row seed batch's real
OpenSky timestamps crossed the 3-minute cutoff), and the DB file stayed
flat at **~3.6–3.7MB** throughout (incremental_vacuum + wal_checkpoint
TRUNCATE keeping it in check despite continuous churn). **PASS.**

### RSS at ~20 min
**450304 KB (≈440 MB)**, sampled at 24:08 process uptime via
`ps -o rss= -p <pid>`. RSS trend: ~264MB at 19s uptime → ~440–450MB by
~4.5 min uptime → flat (447–450MB) for the remaining ~20 minutes — this is
a real, early-plateauing steady state, **not a leak**. It is **much higher
than the implementing agent's early-boot figure (~208–218MB)**, and lands
almost exactly at **Gate A1's Postgres-backed baseline (~442MB)** rather
than meaningfully improving on it. Plausible cause: `mmap_size=256MB` in
the pooled DataSource's PRAGMAs — once the ~11k-row sweep and the repeated
full-table reads from my blackbox/golden-capture testing touch a large
fraction of the file via the memory-mapped I/O window, those pages become
resident and count toward RSS. This is worth the orchestrator's attention
before claiming a memory win from the SQLite migration — the "SQLite is
lean" expectation did not hold at steady state on this machine/workload.

### Restart persistence
Hot-poll counter before kill: `hotpoll.call_count = 26`. Restarted process
(same DB file) came up and reached `Started FlightTrackerApplication in
1.587 seconds`; `LiveStateStore warm-up: loaded 11327 aircraft` at +1.1s.
Counter read back as `28` ~20s after restart (2 new poll ticks had already
fired by the time I checked) — **confirmed persisted, not reset to 0**.
Live map (`/api/flights/live`) returned all 11,327 positions well within
5s of process start. **PASS.**

### `auto_vacuum` fresh-boot fix
Verified exactly as specified: `rm -rf`'d the live-run directory, booted
against a brand-new `flighttracker.db`, then immediately (before any other
connection could touch the file):
```
$ sqlite3 flighttracker.db "PRAGMA auto_vacuum; PRAGMA journal_mode;"
2
wal
```
`auto_vacuum` reads **2 (INCREMENTAL)** from a genuinely cold start.
**Fix verified working.**

### Diff review (`git diff 0427f91..bdb8ee6`)
29 files changed, all under `backend/src/**` or `backend/pom.xml`
`<dependencies>` — **no out-of-scope edits**. No secrets (the one
`- password: flighttracker` diff line is the *removal* of the old
Postgres dev-default credential, not an addition). No TODO/FIXME/XXX
introduced. Schema rewrite matches PLAN §6 A2 exactly:
- 4 required indexes present: `idx_position_recent` (partial,
  `on_ground=0`), `idx_position_observed_at`,
  `idx_position_icao_ground_time`, `uq_position_icao_time_source`.
- All 3 obsolete tables (`aircraft_latest_position`, `poll_window`,
  `viewport_state`) actually gone — not just commented out.
- Timestamps genuinely `INTEGER` epoch-millis everywhere (verified every
  timestamp column in `schema.sql` and every repository's
  `Timestamps.toEpochMilli`/`fromEpochMilli` usage — no mixed
  `TIMESTAMPTZ`/`java.sql.Timestamp` left anywhere in `backend/src/main`).
- SQL translations (`DISTINCT ON`→`ROW_NUMBER()`, `IS DISTINCT FROM`→
  SQLite's null-safe `IS NOT`, `DELETE...LIMIT`→id-IN-subquery,
  `RETURNING *`) all correct and covered by the integration test.
- Write-reduction flag, retention rewrite, Clock injection throughout:
  all match the spec and are well-reasoned in code comments.

Spot-read `AircraftRepository`, `FlightPositionRepository`,
`AirportRepository`, `AppStateRepository`, `SqliteDataSourceConfig`,
`PositionRetentionService`, `PositionPersistenceService`,
`AircraftController`, `AircraftEnrichmentService`, `EstimatorAgent`,
`EstimatedPositionService`, `UsageService` in full — all renames are
mechanical and consistent (record accessors, no leftover getters), null
handling is careful throughout.

## `auto_vacuum` fresh-boot fix
See above — **verified: yes**.

## Concerns (non-blocking)

1. **`docs/cloud-migration/golden/SHAPES.md` on this branch is stale.**
   The Gate-A1 correction to the `/history` endpoint's documented shape
   (commit `24aee57`, which fixed it from the wrong trimmed 7-field shape
   to the correct full 12-field `FlightPosition` shape) exists only on
   `feat/cloud-migration`, not on `feat/cm-backend` — `git merge-base
   --is-ancestor 24aee57 bdb8ee6` is false. The *app's actual behaviour*
   is correct and matches the corrected shape (verified by direct
   capture), so this isn't an A2 regression, but a future verifier reading
   only this branch's copy of SHAPES.md would be misled into thinking
   `/history` is broken. Recommend merging/cherry-picking `24aee57`'s docs
   change into `feat/cm-backend` before Phase M.
2. **20-minute live run only produced one data-bearing global sweep**, not
   three, because of real anonymous-OpenSky throttling — likely compounded
   by my own test method (a second app instance hot-polling OpenSky in
   parallel for ~4 minutes, per the orchestrator's own suggested
   parallelization). The sweep *mechanism* (scheduling, health tracking,
   batch-insert speed) is fully verified; actual sustained data flow from
   OpenSky's free tier was not. If this matters for a future gate, run the
   retention test against a source other than live OpenSky, or serialize
   it after the main run instead of overlapping.
3. **RSS at steady state (~440MB) does not show the improvement a SQLite
   migration might be expected to deliver** over A1's Postgres-backed
   ~442MB baseline — see analysis above (likely `mmap_size=256MB` pulling
   pages into residency once enough of the file has been touched). Not a
   regression, but worth knowing before any claim that A2 reduced memory
   footprint.
4. **A benign `ERROR`-level log line appears repeatedly**
   (`TransactionSynchronization.afterCompletion threw exception` /
   `IllegalStateException: Message will not be sent because the WebSocket
   session has been closed`, in `LiveFeedBroadcaster.publish`) when a
   WebSocket client disconnects right as a broadcast fires. Pre-existing
   behavior unrelated to A2 (the only A2-era change to that file is a
   getter→record-accessor rename), triggered here by my own blackbox
   WebSocket tests' connect/disconnect churn. Caught and swallowed, app
   continues correctly, but it's log noise at ERROR severity for a normal
   race — worth a tracking issue, not a gate blocker.
5. The hand-off's `docker-compose.yml`/`deploy/docker-compose.yml`
   obsolescence note (PLAN §6 A2 item 9: "list them in the hand-off") isn't
   actually present in the hand-off report text I was given. Confirmed
   both files still exist (correctly not deleted yet), just flagging the
   hand-off gap for the orchestrator's Phase M tracking.
