# Idle-cost profile, October 2026

Profiled `main` at `5aa8262` (Spring Boot 4.1.2, Jackson 3) on a synthetic
database the size of production's, with every external source stubbed. The
question: why an idle app on a CX23 (2 vCPU, 3.8 GB) reads 15–20 MB/s from
disk, and which platform suits a mostly headless, single-user tracker.

**Measured** means a number from a run described under *Method*. **Estimated**
means arithmetic or documentation, not a run. This sandbox has 4 vCPU, 16 GB
RAM and fast storage, so absolute timings run faster than on the CX23. The
ratios between runs are the useful part.

## Summary

1. **The idle disk reads come from memory pressure, not a runaway query.**
   Every background statement has a sane plan, and between jobs the app reads
   about 0.03 MB/s. But `MemoryHigh=1400M` in the unit also counts the kernel's
   page cache for the database. The JVM's anonymous memory keeps growing toward
   that limit: the 768 MB G1 heap, about 260 MB of JVM non-heap, and up to
   4 × 64 MB of SQLite page cache that sits on the native heap, invisible to
   NMT. As it grows, less and less page cache is left for a 1.5 GB file whose
   hot set is about 530 MB of indexes keyed by `icao24`, which are written in
   random order.
   - **Measured, same 1400 MB limit:** with page cache at 553 MB (fresh JVM),
     idle reads are 0.24 MB/s. With page cache squeezed to 168 MB (heap
     pre-touched to emulate a JVM that has been up for hours), idle reads rise
     to **2.97 MB/s (12×)**: 16.5 major faults/s, disk reads larger than the
     logical reads (readahead and refaults), and the global-sweep insert
     doubles to 2.2–2.4 s ("over the 2s budget").
   - **Inferred, not reproduced:** production's constant 15–20 MB/s is the same
     curve one step further. `used 1909 MB` suggests the JVM's anonymous memory
     is about 1.3 GB, so almost no page cache is left. The commands under
     *Verify in production* confirm or refute this in a minute.
2. **Each sweep and each prune touches about 25 KB of pages per row.**
   `flight_position` has four indexes (796 MB, more than the 692 MB table),
   and two of them lead with `icao24`. Measured on the tuned run: about 340 MB
   of logical reads per ~12k-row global sweep and about 290 MB per 10-minute
   prune (including its checkpoint). Those reads are cheap from page cache and
   expensive from disk. `deleteStaleWithNoPositions` added another 127 MB every
   10 minutes (99 MB from disk when cold). Two indexes, `idx_position_recent`
   and `idx_position_icao_ground_time` (358 MB together), are not chosen by
   any current query plan I checked.
3. **The quick wins remove the symptom without leaving Spring.** The changes
   are a 384 MB Serial-GC heap, an 8 MB SQLite cache per connection, a nightly
   stale-aircraft prune, and dropping the unused validation starter.
   - **Measured, same limit and data:** anonymous memory falls from 1220 MB to
     **600 MB**, with the heap fully pre-touched (worst case).
   - Idle disk reads fall from 2.97 to **0.047 MB/s**, CPU from 3.6% to 2.2%
     of a core, and sweep inserts take 0.5–1.4 s.
4. **Rust would save memory, not I/O.** The Rust spike ingests the same sweeps
   into the same schema and serves the same live query.
   - **Rust (measured):** 50 MB RSS and 0.022 MB/s idle reads. Its sweep insert
     takes as long as the JVM's (1.3–2.2 s), because SQLite does the work.
   - **Native image (measured):** builds and boots (RSS 513 MB with the old
     64 MB caches, 2.2 s startup beyond the DB warm-up). It failed at runtime in
     two places tests can't see: missing classpath resources and Jackson
     reflection on records.
5. **Freshness is fragile for reasons separate from the I/O.**
   - Anonymous OpenSky allows fewer global calls per day than the 240
     scheduled.
   - The global sweep and the hot poll share one backoff.
   - The 429 back-off ignores OpenSky's `X-Rate-Limit-Retry-After-Seconds`
     header.
   - `lastSweepAt` advances even when a sweep fetched nothing, so a stuck
     `lastSweepAt` means the sweep was still *running*. That fits slow inserts
     under I/O starvation.

**Recommendation: keep Spring Boot on the JVM and ship the quick wins** (PRs 1–2
below, then the index drop). That buys about 600 MB of headroom for
Paperclip + Hermes, at hours of effort and low risk to the invariants. A
native image is the next lever only if memory is still tight afterwards, and
it needs CI runs of the blackbox suite against the binary. A Rust rewrite
would save another ~550 MB at 4–8 weeks of solo work, with real risk to the
wire format and estimator invariants, and no I/O benefit. It isn't worth it
for this app.

### Verify in production (read-only, no restart)

```bash
CG=/sys/fs/cgroup/system.slice/flight-tracker.service
grep -E '^(anon|file|file_mapped|workingset_refault_file|pgmajfault) ' $CG/memory.stat
cat $CG/memory.events          # "high" climbing = being throttled at MemoryHigh
cat $CG/memory.pressure        # some/full avg10 > 0 = stalls on reclaim
grep -E 'VmRSS|RssAnon|RssFile' /proc/$(systemctl show -p MainPID --value flight-tracker)/status
journalctl -u flight-tracker --since today | grep -E 'over the 2s budget|batched insert|OpenSky polling is|429'
```

If `anon` is ≥ 1.2 GB, `file` is a few hundred MB or less, and
`workingset_refault_file` keeps rising, finding 1 holds.

## Idle cost breakdown

Every scheduled method in the code (`grep -rn "@Scheduled(" backend/src/main`):

| Job | Cadence | DB work per run (measured) | Avg logical reads | CPU share of Java samples (JFR, baseline) | Notes |
| --- | --- | --- | --- | --- | --- |
| `AgentOrchestrator.pollGlobalSweep` | 360 s fixed delay | one txn: ~12–15k `aircraft` upserts and `flight_position` inserts (`batchUpdate`, prepared once). **~340 MB logical reads** and ~250 MB written (WAL plus autocheckpoint). Inserts took 0.5–1.4 s with enough page cache and 2.2–2.4 s when starved | ~0.95 MB/s | 3.6% | Two `icao24`-leading indexes make inserts random B-tree writes |
| `PositionRetentionService.prune` | 10 min | `DELETE … id IN (SELECT … ORDER BY observed_at LIMIT 5000)`. **~33 MB per 5000-row batch** (probe), about 290 MB per run with `incremental_vacuum(2000)` and `wal_checkpoint(TRUNCATE)` | ~0.48 MB/s | 0.5% | Delete updates all 4 indexes |
| …its `deleteStaleWithNoPositions` | was 10 min, now nightly | `SCAN aircraft` plus `NOT EXISTS` probe per aircraft: **127 MB logical, 99 MB disk cold, 1.9 s cold / 0.2 s warm** | was 0.21 MB/s | – | Prototype moves it to 03:00 |
| …its training-table deletes | 10 min | indexed range deletes, ~0 MB | – | – | fine |
| `PositionRetentionService.nightlyOptimize` | 03:00 | `PRAGMA optimize` ran `ANALYZE` (371 ms). Plans before and after stats are identical | – | – | fine |
| `EstimatorAgent.refresh` | 30 s | in-memory over ~54k live aircraft. Up to 300 gap snapshots per tick: **300 loads = 2.5 MB, 43–62 ms** (`uq_position_icao_time_source` range) | ~0.08 MB/s worst case | **64%** | The app's main CPU cost: `ConcurrentHashMap.get`, `isInGap`, route cache lookups |
| `CallsignRouteService.resolveNext` | 500 ms | one adsbdb HTTP call, then one autocommit `callsign_route` upsert (PK) | ~0 | 9% | ≤2 external calls/s around the clock, with nobody watching |
| `ArrivalConfirmationService.tick` | 30 s | memory only, unless a provider has a key. Board match does one PK lookup on `aircraft` | ~0 | <1% | Providers disabled in these runs (no keys) |
| `AgentOrchestrator.pollAll` | 18 s, poll window only | none while the window is closed | 0 | 2% (first 5 min) | |
| `AirportSeedService.sync`, `RunwaySeedService.sync` | startup + 24 h | ~10k and 16.5k upserts | – | 1.5% | |
| `LiveFeedBroadcaster.sendKeepalive` | 30 s | returns at once with no WebSocket sessions | 0 | 0 | |
| startup `LiveStateStore.warmUp` | once | 224 MB logical; **8.0 s cold / 0.6 s warm** | – | – | dominates startup on every platform |

Idle between jobs (measured, all JVM runs): rchar ≈ 0.03–0.3 MB/s,
read_bytes ≈ 0.01–0.04 MB/s.

**Root cause of the reads.** Sweep and prune together average about 1.4 MB/s
of logical page reads (estimated from the per-run numbers above), spread over
about 530 MB of randomly accessed index pages plus the table tail. Whether that
reaches the disk depends only on how much page cache the cgroup leaves:

| Run (same DB, same 1400 MB limit) | Anon RSS (end) | Page cache in cgroup | read_bytes, idle window | majflt/s | Sweep insert |
| --- | --- | --- | --- | --- | --- |
| baseline: prod flags, fresh JVM, 20 min | 829 MB, still rising | 553 MB | 0.243 MB/s | 0.7 | 0.8–1.2 s |
| steady: prod flags, heap pre-touched (≈ hours-old JVM) | 1220 MB, still rising | 168 MB | **2.965 MB/s** | 16.5 | 2.2–2.4 s |
| tuned: quick wins | 600 MB, flat | ~700 MB | **0.047 MB/s** | 0.1 | 0.5–1.4 s |

In the steady run, read_bytes (2.97 MB/s) exceeds rchar (1.84 MB/s). Pages are
being re-read from disk with readahead, including the JVM's own mapped files,
which is why the app stalls even between jobs. Not reproduced here: the
CX23's slower disk and 2 vCPUs, the cgroup-v2 `MemoryHigh` throttling (I had
cgroup v1 `limit_in_bytes`), and a JVM up for days. All three push the same
curve further.

**Memory breakdown (NMT, measured).** Baseline at 20 min: NMT committed 529 MB
(heap 345 of 768, G1 structures 50 MB, metaspace 46, code 25, symbols 16, JFR
16). Anonymous RSS was 829 MB, so about 300 MB sat outside NMT: SQLite's
per-connection page caches plus malloc arenas. Steady: NMT 964 MB vs anon
1221 MB. Tuned: NMT 505 MB (heap 384, Serial GC structures 1.3 MB) vs anon
601 MB. Heap live set: old gen ~190–198 MB after GC, with this synthetic data's
306k callsign routes (production probably holds fewer). GC is negligible
everywhere: baseline G1 had 32 pauses, 453 ms total in 20 min. Tuned Serial had
10 young GCs (0.68 s) and 3 full GCs (0.79 s) in 13 min.

**Effective PRAGMAs.** Read back through the app's exact JDBC URL and driver
3.53.4: `journal_mode=wal`, `synchronous=1` (NORMAL; the driver default is
FULL, the URL overrides it), `cache_size=-65536` **per connection** (pool of
4), `mmap_size=268435456`, `wal_autocheckpoint=1000`, `page_size=4096`,
`auto_vacuum=2` (incremental), `temp_store=2`, `busy_timeout=5000`,
`journal_size_limit=-1`.

**Transactions and statements.**
- The global sweep is one transaction (`@Transactional persistBatch`, two
  `batchUpdate`s, each prepared once).
- A hot poll is one transaction, but row by row: `insertIfAbsent` plus
  `INSERT … RETURNING *` per report.
- Training writes are one transaction per estimator tick (`TrainingDataService.flush`).
- Retention runs one transaction per 5000-row batch.
- Route upserts and confirmation-budget writes autocommit one by one, at ≤2 per second.

With WAL + NORMAL a commit doesn't fsync (only checkpoints do), so the
Quarkus pitfall from the $12 challenge (FULL sync, an fsync per request)
doesn't apply. Statements: `JdbcTemplate`/`JdbcClient` prepare and close a
statement per call, and neither Hikari nor sqlite-jdbc caches them, so
single-row statements are re-parsed every time. At this app's few statements
per second that costs microseconds (estimated). Not worth changing.

**Query plans** (EXPLAIN QUERY PLAN, real schema, 8.6M rows, before and after
`PRAGMA optimize` stats; identical except where noted):

| Statement | Plan | Flag |
| --- | --- | --- |
| estimator `findByIcao24AndObservedAtBetween` | SEARCH `uq_position_icao_time_source` (icao24=? AND observed_at range) | ok |
| retention delete batch | SEARCH COVERING `idx_position_observed_at` (observed_at<?) + rowid | ok |
| `deleteStaleWithNoPositions` | **SCAN aircraft** + correlated SEARCH COVERING `idx_position_icao_ground_time` | full scan + 62k probes; moved to nightly |
| training deletes | SEARCH their `captured_at`/`labelled_at` indexes | ok |
| sweep/route/aircraft upserts | PK / unique-index conflict target | ok |
| `findById` (confirmation) | SEARCH PK | ok |
| warm-up (`MAX(observed_at) … GROUP BY icao24`) | **SCAN COVERING `idx_position_icao_ground_time`** (no stats); SEARCH `uq_…` ANY(icao24) (with stats) | startup only |
| dossier `findCurrentLegTakeoffTime` | SEARCH `uq_…` (icao24=?) + **temp B-tree for ORDER BY** | UI only; 10 ms cold |
| dossier max/at-or-before altitude | SEARCH `uq_…` | ok |
| `/api/usage` fleet window | SEARCH `idx_position_observed_at` + **temp B-tree** (no stats); SEARCH `uq_…` ANY(icao24) (with stats) | UI only; 1 h window = 184 MB, 0.3–0.4 s |

None chose `idx_position_recent`. `idx_position_icao_ground_time` is chosen
only by the stale-aircraft probe and the stat-less warm-up, and
`uq_position_icao_time_source` serves both.

Table and index sizes (dbstat): `flight_position` 692 MB,
`uq_position_icao_time_source` 301, `idx_position_icao_ground_time` 228,
`idx_position_observed_at` 137, `idx_position_recent` 129, `callsign_route` 32,
`track_end_feature` 25, `track_end_label` 8, `aircraft` 4.5.

## Quick wins

Prototyped on `claude/perf-profile`. The before/after numbers are the
steady → tuned runs, which applied rows 1–4 together. Per-row attribution comes
from NMT and the statement probes, not from separate runs.

| # | Change | Before → after | Risk | Effort |
| --- | --- | --- | --- | --- |
| 1 | Unit: `-Xms128m -Xmx384m -XX:+UseSerialGC -XX:ReservedCodeCacheSize=64m -Xss512k` (was `-Xms256m -Xmx768m -XX:+UseG1GC`) | heap ceiling 768 → 384 MB; GC structures 59.5 → 1.3 MB (NMT). Combined with #2: anon 1220 → 600 MB, idle reads 2.97 → 0.047 MB/s, CPU 3.6 → 2.2% (measured) | OOM if the live set more than doubles; `ExitOnOutOfMemoryError` + `Restart=on-failure` cover it. Old gen was 188 of 256 MB with a generous synthetic route table. Full GCs ~0.26 s each | 15 min, plus a one-time manual unit update on the VM (`deploy.sh` doesn't install the unit; cloud-init does) |
| 2 | SQLite `cache_size` 64 → 8 MB per connection (`flighttracker.sqlite.cache-size-kib`) | untracked native memory ~260 → ~96 MB (anon minus NMT, including malloc arenas); sweep insert unchanged (0.5–1.4 s) (measured) | low: the kernel cache does the caching | done |
| 3 | `deleteStaleWithNoPositions` every 10 min → nightly | −127 MB logical reads per 10 min (−0.21 MB/s average; 99 MB from disk per run when cold) (measured by probe) | none: the rule is "not seen for 7 days" | done, with test |
| 4 | Drop `spring-boot-starter-validation` (no `@Valid` or `jakarta.validation` in `src/main`) | jar 37.4 → 35.8 MB; startup 14.5 → 13.4 s (within noise; the DB warm-up dominates) | none found. No Spring-context test exists; the jar booted in the tuned run | done |
| 5 | *Proposed:* drop `idx_position_recent` and `idx_position_icao_ground_time` (`DROP INDEX IF EXISTS` in `schema.sql`) | −358 MB of file (measured sizes); est. −40–50% of the page touches per sweep/prune (estimated, not measured) | medium: re-check plans for every query, including `/search` and history; one-time page reclaim via incremental vacuum | ½ day |
| 6 | *Proposed:* estimator runs after each sweep, and on its 30 s tick only while a viewer is connected | est. −60% of the app's Java CPU at idle (it is 64% of samples) | medium: the gap and estimate timing feed the training capture and confirmation candidates | 1 day |
| 7 | *Proposed:* route lookups paced down when nobody is viewing (e.g. 10 s instead of 500 ms) | est. −9% CPU, −170k adsbdb calls per day | low | 1 h |
| 8 | *Not measured:* `MALLOC_ARENA_MAX=2` in the unit; Hikari pool 4 → 2 | caps glibc arena growth from JNI allocations on many threads | low | 15 min |

Not recommended: `-XX:TieredStopAtLevel=1`, because the estimator loop is the
CPU cost and C1 code runs it slower (not measured). CDS/AOT cache: Java 21
AppCDS saves seconds of startup and a little RSS, and Java 25's AOT cache
more. Startup isn't the constraint, and the DB warm-up dominates it anyway.
`mmap_size`: kept. The mapped pages are page cache, reclaimable and shared.

## Platform options

| | (a) Spring Boot on JVM, tuned | (b) Spring Boot 4 native image | (c) Rust (axum + tokio + rusqlite) |
| --- | --- | --- | --- |
| Idle RSS | **632 MB mean, 600 MB anon** (heap pre-touched; measured) | **513 MB, 433 anon** (measured, but with the old 4 × 64 MB SQLite caches and route lookups failing; est. 300–380 MB with #2) | **50 MB, 45 anon** for the spike (measured); est. 60–120 MB for a full port |
| Idle I/O (read_bytes) | 0.047 MB/s (measured) | 0.051 MB/s (measured) | 0.022 MB/s (measured) |
| Idle CPU | 2.2% of a core (measured) | 0.9% (measured; understated, route lookups were failing) | 0.2% (measured; spike has no estimator) |
| Sweep ingest, ~12–15k rows | 0.5–1.4 s | 1.2 s | 1.3–2.2 s: same, SQLite-bound |
| Startup | 13.4 s, of which 7.6 s DB warm-up | 9.9 s, of which 7.7 s warm-up | 8.4 s, all warm-up |
| Build | `mvn verify` ~1 min | **8 min 16 s, 6.2 GB peak RSS** (measured): CI only, never on the CX23 | `cargo build --release` 2.5 min clean; 3.6 MB binary |
| Porting effort | hours | 2–4 days: resource hints (`airports.tsv`, `runways.tsv` were missing), reflection hints for `AdsbdbClient`'s records (792 `UnsupportedFeatureError`s in 9 min), blackbox suite against the binary in CI, deploy ships a binary | 4–8 weeks solo: ~6.6k non-comment lines of Java, 438 tests to re-create; the blackbox suite covers only 6 areas |
| Risk to CLAUDE.md invariants | none | medium: failures happen only at runtime and only show in logs; JVM tests don't see them | high: `LiveFrame` wire format, leg-detection SQL, gap estimator physics, confirmation budgets, `FlightDataAgent` extension model all re-implemented |
| Ongoing cost for a solo owner | as today | every dependency bump can break reachability metadata; +8 min per CI build | second toolchain; no GC tuning and a tiny footprint |

External figures (from the "$12 server challenge", 1 vCPU / 2 GB; its metric
is maximum concurrent users, **not** idle cost, so these show what each stack
can do, not how cheap it idles):
- **SQLite settings mattered as much as language.** Java/Quarkus placed 26th of
  27 (29k users) because it left `synchronous` at FULL. This app already runs
  WAL + NORMAL (read back above).
- **The JVM can be lean:** Kotlin NIO 7th (120k users, 1.38 GB), Java FFM
  epoll 9th (102k, 555 MB), Scala Netty 12th (90k, 825 MB). There was no
  Spring entry.
- **Rust's footprint depends on design:** rust-epoll 98 MB (batch 1) and
  630 MB at 264k users (batch 2); rust-axum 61 MB in one entry and 1.13 GB in
  another.
- **SQLite settings in the top entries** (rust-epoll-scooter1337,
  go-epoll-MegaPanchamZ): WAL, `synchronous=NORMAL`, `locking_mode=EXCLUSIVE`,
  `wal_autocheckpoint=0` with explicit checkpoints, `journal_size_limit=64 MB`,
  small or moderate `cache_size`, and group commit. Only `journal_size_limit`
  and explicit checkpointing carry over. `EXCLUSIVE` needs a single
  connection, and this app pools 4.

Our measurements agree: once SQLite is configured sanely, I/O is the same on
every platform, and the remaining difference is resident memory.

## Freshness

From `OpenSkyAgent`, `PollBackoff`, `AgentOrchestrator` and `SweepHealthTracker`:

- **When the sweep "skips".** `fetchStates` returns an empty list while
  `PollBackoff` is cooling down. One `PollBackoff` per agent is shared by the
  hot poll and the global sweep, so a 429 on a hot poll also silences the
  next global sweep. Backoff grows 30 s → 5 min on 429/timeout and
  2 → 10 min on 5xx. The sweep runs with a *fixed delay* of 360 s after the
  previous one *finished*, so slow inserts stretch the period too.
- **`lastSweepAt` isn't a freshness signal.** `runGlobalSweep` calls
  `recordSweepCompleted()` whether or not any data arrived, so a skipped or
  429'd sweep still advances it. `lastSweepAt` stuck at 18:13:27 at 18:20 and
  18:22 therefore means the next sweep (due at 18:19:27) *was still running*,
  not that it was skipped. A ≥2.5 min sweep fits inserts under I/O starvation:
  measured 2.4 s in the steady run on fast storage, and the CX23 is further
  down that curve. `journalctl … | grep 'batched insert'` shows the real
  durations.
- **Anonymous vs OAuth credits** (from OpenSky's REST documentation; not
  verified here):
  - Anonymous clients get 400 credits per day, OAuth (standard) accounts 4000.
  - A global `/states/all` costs 4 credits; bbox calls cost 1–4 by area.
  - 240 sweeps a day × 4 = 960 credits, so **anonymously the global sweep
    alone runs out after ~100 sweeps (~10 h)**, and the rest of the day is
    429s.
  - OpenSky signals the wait in `X-Rate-Limit-Retry-After-Seconds`, but
    `retryAfter()` reads only `Retry-After`. The app falls back to its own
    capped backoff and keeps knocking.
  - Whether production is anonymous shows in the log line
    `OpenSky polling is anonymous (...)`.
- **Making it reliable at minimal cost:**
  1. Set `OPENSKY_CLIENT_ID`/`OPENSKY_CLIENT_SECRET` (an ops change, no code).
  2. Parse `X-Rate-Limit-Remaining` and `X-Rate-Limit-Retry-After-Seconds`,
     and pace the sweep from the remaining credits.
  3. Give the global sweep its own `PollBackoff`, and make hot polls yield
     when the credits left wouldn't cover the remaining sweeps.
  4. Record `lastSweepAt` only when rows were written. Expose
     `lastSweepRows` and a skip counter in `/api/health`.
  5. Keep the inserts fast: the quick wins above.

## Method

Everything lives in the session scratchpad. The scripts are small and are
described here so the runs can be repeated.

- **Synthetic DB** (`gen_db.py`, `sim.py`):
  - **Fleet:** 62,000 airframes fly between the 3,247 airports in the app's
    own `airports.tsv`/`runways.tsv` that have an IATA code and a runway of at
    least 1800 m. Most flights are under 2000 km; ground time averages 13 h.
    Calibrated to ~13k airborne aircraft, as in production.
  - **Writes:** one simulated 360 s global sweep per transaction into the
    app's `schema.sql`, with every index in place from the start, so pages
    fragment as in production. Coverage is 88% (50% for 6% of airframes),
    which creates gaps. Skip-unchanged-ground is emulated.
  - **History:** 80 h simulated, with a rolling 72 h delete plus
    `incremental_vacuum(2000)` every hour once past 72 h, so freed pages get
    reused.
  - **Result:** 1.65 GB file, 8.60M `flight_position` rows (~12k per sweep),
    61.9k `aircraft`, 306k `callsign_route` (more than production, because
    every simulated flight gets a new callsign), 120k `track_end_feature`,
    96k `track_end_label`. 400 s to build.
- **External sources** (`stub.py`): one local HTTP server continues the same
  simulated world in real time. It serves `/api/states/all` (global: ~16.2k
  states, 2.3 MB; bbox) and adsbdb `/v0/callsign/*` (80% found) and
  `/v0/aircraft/*` (404). Nothing contacted OpenSky, adsbdb, Swedavia or
  AeroDataBox; confirmation providers stayed disabled without keys.
- **Runs** (`experiment.sh`, `run_app.sh`):
  1. Copy the DB and `drop_caches`.
  2. Start the app in a cgroup-v1 memory group with `limit_in_bytes=1400M`
     (stands in for `MemoryHigh=1400M`; both charge page cache to the app).
     External URLs are pointed at the stub via `-D` properties.
  3. Sample `/proc/<pid>/io` (read_bytes, rchar, write_bytes),
     `/proc/<pid>/stat` (CPU ticks, major faults), `/proc/<pid>/status`
     (VmRSS, RssAnon, RssFile) and the cgroup's `memory.stat` (rss, cache)
     every 5 s (`monitor.py`).
  4. Also collect `jstat -gc` every 10 s, and
     `jcmd VM.native_memory summary` (`-XX:NativeMemoryTracking=summary`) and
     `GC.heap_info` 20 s before the end.
  5. The baseline also recorded JFR (`settings=profile`). Samples were
     attributed to scheduled jobs by stack (`jfr_jobs.py`).
  6. Idle windows (`window.py`) start after the first global sweep: baseline
     420–1170 s, steady and tuned 400–770 s, native 400–530 s, Rust 60–470 s.
     Each run includes sweeps and prunes, because production's idle includes
     them too.
- **Statement costs** (`Probe.java`): sqlite-jdbc 3.53.4 with the app's exact
  URL. EXPLAIN QUERY PLAN, then each statement once, cold (after
  `drop_caches`) and warm, rolled back. `/proc/self/io` and fault deltas
  around each statement. `PRAGMA optimize` and stats via `Opt.java`, effective
  PRAGMAs via `Pragmas.java`, sizes via `dbstat` (`Sizes.java`).
- **Native image**: GraalVM JDK 25.0.4 (Oracle),
  `mvn -Pnative -DskipTests native:compile` on a copy of `backend/` without
  the frontend. Run with `-Xmx384m`.
- **Rust spike** (`rust-spike/`, ~250 lines): rusqlite (bundled), one
  connection, `cache_size` 8 MB, `mmap_size=0`, the same warm-up idea (one
  `GROUP BY icao24` query), a sweep every 360 s in one transaction with cached
  prepared statements, and `GET /api/flights/live` from an in-memory map.
  Not ported: the estimator, enrichment, confirmation, retention and
  WebSocket.
- **Not measurable here:** production's page-cache contents and refault
  rates, cgroup-v2 `MemoryHigh` throttling, the CX23's disk and CPU, OpenSky's
  real credit behaviour, and real data's live set (callsign count). Hence
  *Verify in production* above.

## Proposed next PRs, smallest first

1. **Memory:** the unit flags (#1) and the SQLite cache (#2). Already
   prototyped (`2e2c897`, `35c1fd7`). Include the one-off VM step: install the
   new unit, `systemctl daemon-reload`, restart. Before and after, record the
   *Verify in production* output.
2. **Background reads:** stale-aircraft prune nightly (#3, `743b50b`) and the
   validation starter (#4, `73c90be`).
3. **OpenSky freshness:** read `X-Rate-Limit-*`, a separate backoff for the
   sweep, `lastSweepAt` only on success plus a skip counter in
   `/api/health`. Ops step: OAuth credentials.
4. **Indexes:** drop `idx_position_recent` and `idx_position_icao_ground_time`
   (#5), after re-checking every query's plan. Measure the sweep and prune
   page reads before and after with this method.
5. **Work when it matters:** estimator after sweeps and while viewed (#6);
   route lookups slower when idle (#7).
6. *Only if memory still binds after 1–5:* a native-image CI job that runs
   the blackbox suite against the binary, with the resource and reflection
   hints found here.
