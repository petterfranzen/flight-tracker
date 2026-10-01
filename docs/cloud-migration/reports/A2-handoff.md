## sqlite-migrator · A2 · PASS

**Branch / last commit:** `feat/cm-backend` @ `bdb8ee6` (3 commits on top of A1's `0427f91`, same worktree/branch as briefed).

**What changed (by file group), in PLAN §6 A2 order:**
1. `828deec` (bulk of the work) — `pom.xml`: removed `org.postgresql:postgresql` + `spring-boot-starter-data-jpa`, added `org.xerial:sqlite-jdbc:3.53.4.0` + `spring-boot-starter-jdbc` (`<dependencies>` only, `<build>` untouched). `schema.sql` rewritten for SQLite (INTEGER epoch-millis timestamps, `INTEGER PRIMARY KEY`, `REAL`, `INTEGER` booleans; dropped `aircraft_latest_position`/`poll_window`/`viewport_state` entirely, dropped the advisory lock and autovacuum tuning; kept all four required indexes). New `config/SqliteDataSourceConfig` (hand-built `HikariDataSource`, `maximumPoolSize: 4`, all PLAN PRAGMAs in the JDBC URL) and `config/ClockConfig` (one `Clock.systemUTC()` bean). `model/{Aircraft,Airport,FlightPosition}` now plain Java records; `repository/{Aircraft,Airport,FlightPosition}Repository` rewritten as `JdbcClient` + those records, replacing JPA repositories. `repository/Timestamps` is the one `Instant<->long` helper. `AircraftEnrichmentService`'s load/mutate/save pattern replaced with targeted `AircraftRepository.updateEnrichment`/`updateLandingCheck` UPDATEs. `PositionRetentionService` rewritten: 24h→72h, `id IN (SELECT id … LIMIT ?)` instead of `ctid`, `incremental_vacuum`/`wal_checkpoint(TRUNCATE)` after a run with deletions, new nightly `PRAGMA optimize`, plus `aircraft` pruning for rows unseen 7 days with no remaining positions. Write reduction (`flighttracker.persistence.skip-unchanged-ground`, default true) in `PositionPersistenceService`, reading `LiveStateStore` to detect an identical on-ground repeat. Scheduler pool 7→8 for the new nightly-optimize `@Scheduled` method.
2. `e32a467` — `SqlitePersistenceIntegrationTest`: real temp-file SQLite (`@TempDir`, no Testcontainers), exercises insert → live read (`LiveStateStore.warmUp()`'s SQLite rewrite using `ROW_NUMBER()` instead of Postgres's `DISTINCT ON`) → retention (fixed `Clock`) → vacuum, plus a second test for the 7-day stale-aircraft prune.
3. `bdb8ee6` — **real bug caught by live testing, not unit tests**: `PRAGMA auto_vacuum=INCREMENTAL` as schema.sql's first statement was silently a no-op. Root cause: Hikari's first pooled connection (carrying `journal_mode=WAL` in its URL) opens before Spring's schema-init script runs, and switching `journal_mode` finalizes page 1 — where `auto_vacuum` lives — with SQLite's default (NONE), before schema.sql's own PRAGMA gets a turn. Fixed with `SqliteDataSourceConfig.setAutoVacuumOnFreshDatabase`: a bare, un-pragma'd `DriverManager` connection sets `auto_vacuum` before the pooled `DataSource` (or schema.sql) ever touches a fresh file. Re-verified live: `PRAGMA auto_vacuum` now correctly reads `2`.

**Contract impact:** none. No controller route/param/status/JSON field touched — the record conversion changes internal accessor method names only; Jackson serializes a record's components under their own names with no config, so every endpoint's JSON shape is byte-identical (re-verified live against `golden/SHAPES.md`). `git diff --name-only 0427f91..HEAD` touches only `backend/src/**` and `backend/pom.xml` (`<dependencies>` only).

**Tests run + result:**
- `mvn -B verify`: BUILD SUCCESS, 72/72 tests (70 unit + 2 new SQLite integration tests), no Postgres/container dependency at all.
- `grep -rni "postgres\|jpa\|hibernate" backend/` → only comments/docs.
- Live run, no `SPRING_PROFILES_ACTIVE`, fresh `FLIGHTTRACKER_DB_PATH` each time, real anonymous OpenSky polling: boots clean every time (4 separate fresh-DB boots), global sweep seeds ~11.4k aircraft.
- Blackbox suite against the live jar, twice (before and after the auto_vacuum fix): 16/16 passed both times.
- Golden shapes re-checked live post-migration — match.
- `sqlite3` PRAGMA checks: `journal_mode=wal`, `auto_vacuum=2`, row count present and correct.
- Retention sanity check (`FLIGHTTRACKER_RETENTION_HOURS=0.05`, `_INTERVAL_MS=20000`): rows older than cutoff deleted on the first cycle (551 rows at t+2s, another 81 at t+22s); DB file size/row count stable across cycles; `-wal` file truncated to 0 after a checkpoint.
- This is the implementing agent's own shorter sanity pass, not Gate A2's full 20-minute/RSS run — that's the verifier's job.

**Numbers:**
- Batched global-sweep insert: **70–71 ms for ~11.4k rows**, comfortably under the 2s budget.
- `mvn verify`: ~3.6s offline. App boot (empty DB, synchronous seed sweep): ~2s.
- RSS: ~208–218 MB at 16–43s uptime (early-boot reading, not a settled 20-minute figure — flagged for the verifier's own longer run). For context: A1's Postgres-backed single process measured ~442 MB steady-state; this SQLite-backed one looks noticeably lighter even this early.
- DB file size: ~3.6 MB for ~11.4k rows, stable across retention cycles in the short test.

**Needs from other agents:** none identified.

**Files to delete in Phase M:**
- `docker-compose.yml` (root) and `deploy/docker-compose.yml` — obsolete now that there's no Postgres container and no multi-container topology at all. Confirmed still present/untouched in this branch.
- `schema.sql`'s removed tables (`aircraft_latest_position`, `poll_window`, `viewport_state`) are gone already — A1 had deferred them to A2, now removed.

**Open risks:**
- The `auto_vacuum` startup-ordering bug (fixed in `bdb8ee6`) is a good example of something a mocked-JdbcTemplate unit test structurally cannot catch — worth keeping `SqlitePersistenceIntegrationTest` as a standing regression guard.
- RSS numbers above are early-boot, not the 20-minute steady-state Gate A2's checklist wants — the verifier should take its own longer reading.
- `sqlite-jdbc:3.53.4.0` is current latest as of this work; no pinning concerns beyond the explicit version already in `pom.xml`.
- Single-writer lock: `busy_timeout=5000` behavior wasn't stress-tested under genuinely concurrent hot-poll + retention + global-sweep writers overlapping in the same instant — worth a specific concurrent-write stress check if Gate A2's 20-minute real run doesn't naturally exercise it.

App still runs as intended: one process, SQLite file at `FLIGHTTRACKER_DB_PATH` (default `./data/flighttracker.db`), no Docker/Postgres/nerdctl needed at all for this package. Ready for Gate A2 verification.
