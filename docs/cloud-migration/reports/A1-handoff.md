## backend-consolidator · A1 · PASS

**Branch / last commit:** `feat/cm-backend` @ `0427f91` (8 commits on top of `feat/cloud-migration`@`1d5868c`).

**Setup note:** this worktree was not branched from `feat/cloud-migration` as the brief assumed — it started on an unrelated branch based on pre-Phase-0 `main`, missing PLAN.md/golden/baseline entirely. The agent created `feat/cm-backend` from `feat/cloud-migration` in-place before starting. Flagging in case other streams' worktrees had the same mismatch.

**What changed (by file group), in PLAN §6 A1 order, one commit per step:**
1. `44ba49d` — removed every `@Profile("api"|"agent"|"estimator")`; deleted `application-agent.yml`/`application-estimator.yml`; `server.address: ${SERVER_ADDRESS:127.0.0.1}`; scheduler pool 3→6.
2. `cfdecbf` — deleted `PositionNotificationListener`; `PositionPersistenceService.persist()` now publishes `service/live/PositionsPersistedEvent`; `LiveFeedBroadcaster` consumes it via `@TransactionalEventListener(AFTER_COMMIT, fallbackExecution=true)`.
3. `a0e8dae` — new `service/live/LiveStateStore` (`ConcurrentHashMap<String,LiveAircraft>`) replaces `aircraft_latest_position`; ports upsert/landed-streak/estimate-clear semantics exactly; warm-up on startup from `flight_position`. `FlightController`/`AircraftController`/`EstimatorAgent` moved onto it; `FlightPositionRepository` trimmed to `flight_position`-only methods. Airport search re-implemented in Java (was a SQL join). New `LiveStateStoreTest` (14 tests) per item 12.
4. `8adf7c6` — `PollWindowService`/`ViewportService` now in-memory; new `app_state` table + `AppStateRepository` write-through-persist only the two counters PLAN.md required to survive restart (global hot-poll budget, per-IP hot-poll seconds). Deleted `PollWindowRepository`/`PollWindow`, `ViewportStateRepository`/`ViewportState`, `ViewportAsyncConfig`.
5. `22b714f` — `ClientIpResolver.resolve()` prefers `CF-Connecting-IP`; new `flighttracker.rate-limit.trust-local` (`${TRUST_LOCAL:false}`) gates `isLocal()` in `AgentController`. New `ClientIpResolverTest`, `AgentControllerTest`.
6. OpenSky auth on polling (item 8): already implemented in baseline — `OpenSkyAgent.fetchStates()` already attached the bearer token; no change needed, confirmed unchanged.
7. `d413357` — `LiveFeedBroadcaster.sendKeepalive()` sends a native WS ping every 30s; scheduler pool 6→7.
8. `93db114` — `SpaWebConfig` serves `classpath:/static/**` + SPA fallback to `index.html`; `GET /api/health`, `GET /api/health/sweep` (+`SweepHealthTracker`).
9. `0427f91` — fixed a real bug caught by live testing (see below) + scrubbed remaining `@Profile`/`LISTEN`/`NOTIFY` prose so the Gate A1 grep is clean.

**Contract impact:** none. Every existing route/param/status/JSON field unchanged (diffed all `@*Mapping` annotations against baseline); only additions are `GET /api/health` and `GET /api/health/sweep`, both additive per §2. `git diff --name-only feat/cloud-migration...HEAD` touches only `backend/src/**` — no `pom.xml`, no frontend, no workflows.

**Tests run + result:**
- `mvn -B verify` (offline): BUILD SUCCESS, 70/70 unit tests (40 original + 30 new/rewritten).
- Live run against real Postgres (`colima nerdctl`, `postgres:16-alpine`), no `SPRING_PROFILES_ACTIVE`, single process: boots clean, global sweep seeds ~13k aircraft on empty DB.
- Blackbox suite against the live jar: 16/16 passed.
- Golden shapes: re-captured live, all match `golden/SHAPES.md` field-for-field.
- `grep -rn "@Profile\|LISTEN\|NOTIFY\|PGConnection" backend/src/main` → empty.
- `TRUST_LOCAL=false`, `CF-Connecting-IP: 203.0.113.9` from localhost: 3 restarts succeed, 4th → 429 (rate-limited as `.9`, not exempted as local) — verified live with curl.
- WebSocket: opened, received live broadcast traffic throughout, still open (readyState=1) at 155s, closed cleanly on client close(1000) — verified live with a raw `ws` client over the real 30s keepalive-ping loop.

**Numbers:**
- `mvn verify` (offline, warm local repo): ~3.5s.
- App boot (empty DB, synchronous seed sweep of ~13k reports): ~3.5–12.5s depending on JIT/disk warm-up.
- RSS: 288 MB at ~21s uptime (early boot, not steady-state — caught mid-verification, didn't re-run the full 5-minute hold). Not apples-to-apples with baseline's 1,068 MB/5min yet (Postgres still separate container). Recommend re-measuring at the Gate A1 verifier pass and again after A2 (Gate A2 wants a 20-minute RSS reading).
- Bundle/frontend sizes: N/A to A1.

**Needs from other agents:**
- **frontend-vanilla**: none. WS keepalive uses a native WebSocket ping frame, invisible to `subscribeLiveFeed`'s `onmessage` in `flightApi.ts`. No frontend change, no coordination needed — turned out the `{"type":"ping"}` text-frame fallback PLAN §6 item 9 anticipated wasn't necessary for this repo's browser client.
- **ci-deployer**: `GET /api/health`'s `version` field reads Spring Boot `BuildProperties` (`git.sha` additional property), which only exists once the `build-info` Maven goal runs (`pom.xml <build>`, outside A1's boundary). Until wired, `version` correctly falls back to `"dev"` (verified live). Confirmed ci-deployer's `-Dgit.sha=$GITHUB_SHA` already produces the right 40-char SHA per Gate C1's independent verification.

**Files to delete in Phase M:** none from A1 directly. `schema.sql` still defines `aircraft_latest_position`, `poll_window`, `viewport_state` with comments explaining why — per PLAN §6 A2 item 2, dropping those is sqlite-migrator's job in the schema rewrite. Not deleted here to avoid double-churning the same lines.

**Open risks:**
- `HotPollUserBudget` now persists each client IP's hot-poll grant history to `app_state` (one row per IP, comma-encoded) so it survives a restart, per PLAN's literal "per-IP hot-poll seconds must survive a restart" — slightly more machinery than the original in-memory-only design (whose comment called a restart-reset "an acceptable, rare edge case"). Functionally correct and tested, but worth a second look if Petter would rather keep that one specifically restart-naive for simplicity.
- `LiveStateStore`'s warm-up SQL had a real bug (wrong column alias) that `mvn verify` alone never caught — only surfaced running against real Postgres. Fixed and verified live (commit `0427f91`); a reminder that A2's full SQLite rewrite of this same query needs its own live verification, not just unit tests.
- App still runs on Postgres, as required — did not touch persistence technology, dependencies, or `pom.xml`.

Ready for Gate A1 verification.
