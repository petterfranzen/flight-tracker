# Idle-cost profile, November 2026

Re-run of the October profile on `main` at `b005a0a`, after #132 shipped the
memory fix (`docs/perf/PROFILE-2026-10.md`). Two questions: did the memory fix
hold, and does the 2 s global-sweep insert budget hold.

**Measured** means a number from the run described under *Method*. **Estimated**
means arithmetic or documentation, not a run. This sandbox is not October's: it
has **0.4 vCPU** (cgroup `cpu.max` = 40000/100000) and a **2 GiB** memory cap,
against October's 4 vCPU / 16 GB. Absolute timings are therefore slower here
and the run is short; the *shape* of the numbers is what compares.

## Answer

1. **The memory fix held, with margin.** Anonymous RSS sat at a flat
   **414 MB mean (423 MB at the end of the run)** against October's measured
   600 MB, and 370–600 MB during warm-up. NMT committed 412 MB (heap 299 of the
   384 MB ceiling, metaspace 47, code 25, class 8, thread 4, GC 1). Nothing
   grew over the run: RSS was 432 MB at 341 s and 442 MB at 741 s.
2. **The 2 s sweep budget holds.** The two scheduled global sweeps in the
   measurement window inserted 15,661 rows in **499 ms** and **475 ms**. The
   only sub-2 s run is the boot-time seeding sweep, which was **13.9 s** — a
   cold-WAL, cold-cache first insert at 0.4 vCPU, not a steady-state cost.
3. **Idle CPU is lower than October's.** Quiet idle (after the poll window
   closed, 340–741 s of the run): **1.28 % of a core mean, 0.60 % median,
   2.60 % p90**. October measured 2.2 % of a core. The mean is dragged by the
   estimator's 30 s tick, the retention prune and the sweeps.
4. **Idle reads are lower than October's.** In the quiet window read_bytes was
   **0.0089 MB/s** (October tuned: 0.047 MB/s), in 0.2–0.5 MB bursts on
   estimator ticks, with most samples at exactly 0.00. majflt 0.09/s (October
   0.1). Page cache stayed healthy: 1.33 GB in the cgroup, more than the
   1.25 GB database, so the starved-cache failure mode of October's *steady*
   run did not reproduce.
5. **One thing to look at that October did not see: writer-writer
   `SQLITE_BUSY`.** Every exception in the run is
   `[SQLITE_BUSY] The database file is locked`, from the airport/runway seed
   sync, the training flush and the retention `DELETE`, all while the boot-time
   seeding sweep held the write lock. Under 0.4 vCPU they exceed the
   `busy_timeout=5000` ms. The retention `DELETE` also failed on the 10-minute
   prune (that is the 746–791 s burst below). This may be purely this sandbox's
   CPU budget, but it is worth a look on real hardware.

## Numbers against October

| Metric (idle / steady state) | Oct 2026 (tuned) | Nov 2026 (`main` @ b005a0a) |
| --- | --- | --- |
| Anon RSS | 600 MB (heap pre-touched) | **414 MB mean, 423 MB end** |
| RSS | 632 MB mean | 441 MB mean, 499 MB end |
| NMT committed | 505 MB | 412 MB |
| Idle CPU | 2.2 % of a core | **1.28 % mean / 0.60 % median** |
| Idle read_bytes | 0.047 MB/s | **0.0089 MB/s** |
| majflt | 0.1 /s | 0.09 /s |
| Global-sweep insert, ~13–16k rows | 0.5–1.4 s | **475 / 499 ms** |
| GC pauses (young / full) | 10 / 3 in 13 min | 41 / 4 in 14.7 min |
| DB | 8.60M rows, 1.65 GB | 6.78M rows, 1.25 GB |
| JVM flags | `-Xms128m -Xmx384m -XX:+UseSerialGC` | same (from the unit) |

Heap live set: tenured 141 MB of 199 MB after GC, against October's ~190–198 MB
old gen (this DB has 306k callsign routes and the same 62k aircraft). Young GCs
are more frequent here (41 in 883 s vs 10 in 780 s) and the largest young pause
was 103 ms; full GCs totalled 1.34 s in 883 s. That is the 0.4 vCPU showing:
less CPU per collection window, the same live set.

## What happened in the measurement window

Sampled every 5 s from `/proc/<pid>` and the sandbox cgroup:

| Window | CPU | read_bytes | write_bytes | Note |
| --- | --- | --- | --- | --- |
| 0–341 s | ~5–27 % | warm-up | warm-up | Spring start, `LiveStateStore.warmUp`, seeding sweep, seed services |
| 341–741 s (quiet idle, 400 s) | **1.28 % mean, 0.60 % median** | **0.0089 MB/s** | 0.024 MB/s | poll window closed at 294 s; scheduled sweeps at 351 s and 712 s |
| 746–791 s (45 s) | 12.9 % | 4.65 MB/s | 15.45 MB/s | the 10-minute retention prune + checkpoint, which failed |

The sweep cadence here is `initialDelay=360 s, fixedDelay=360 s`, so the first
scheduled sweep fires 360 s after start; the boot-time seeding sweep (because
`hasNoPositions()` is true before `LiveStateStore.warmUp` runs) fires earlier
and is the 13.9 s insert.

## Method

The October scripts lived in a closed cloud session and are gone, so the
harness was rebuilt from *PROFILE-2026-10*'s Method section. It is smaller than
October's in four ways, all listed so the numbers can be read for what they
are. The scripts stayed in the run's scratchpad and are not part of this
docs-only PR; the run can be repeated from the description below.

- **Build:** `mvn -B package -DskipTests` at `b005a0a`; backend jar only.
- **Synthetic DB** (`gen_db.py`): the app's own `schema.sql` with
  `auto_vacuum=INCREMENTAL` set before the first table, 62k aircraft, 306k
  callsign routes, 120k track-end features, and `flight_position` written
  sweep-by-sweep (12k random-key rows per simulated 360 s sweep) so the pages
  fragment the way a real sweep fragments them. **Stopped at 6.78M rows /
  1.25 GB** (October: 8.60M / 1.65 GB) because the generator ran ~10x slower
  than October's 400 s on 0.4 vCPU and the run budget was finite. Table 617 MB;
  indexes 216 (`uq_position_icao_time_source`) + 165 (`idx_position_icao_ground_time`)
  + 111 (`idx_position_observed_at`) + 95 (`idx_position_recent`) MB.
  *Not modelled:* flight physics, coverage gaps, the skip-unchanged-ground
  rule, and the rolling 72 h delete with `incremental_vacuum`.
- **External sources** (`stub.py`): one local HTTP server serving
  `/states/all` with 16,500 state vectors and 404ing adsbdb. Nothing contacted
  OpenSky, adsbdb, Swedavia or AeroDataBox; confirmation providers stayed
  disabled without keys. The app logged `OpenSky polling is anonymous`.
- **Run** (`run.sh`): copy the DB, start the jar with the unit's exact
  flags (`-Xms128m -Xmx384m -XX:+UseSerialGC -XX:ReservedCodeCacheSize=64m
  -Xss512k -XX:+ExitOnOutOfMemoryError`) plus `-XX:NativeMemoryTracking=summary`
  and `-Xlog:gc`, with the OpenSky and adsbdb base URLs pointed at the stub.
  Sample every 5 s (`monitor.py`): `/proc/<pid>/stat` (CPU ticks, majflt),
  `/proc/<pid>/status` (VmRSS, RssAnon, RssFile, VmHWM), `/proc/<pid>/io`
  (read_bytes, write_bytes), and the cgroup's `memory.current` / `memory.stat`
  / `cpu.stat`. `jcmd VM.native_memory summary` and `GC.heap_info` at the end.
  Sweep timings come from the app's own log line
  (`PositionPersistenceService`: "batched insert of N rows took M ms").
- **Deviations from October's method, each with its effect:**
  1. **No cgroup `MemoryHigh=1400M`.** The sandbox cgroup is not writable
     (`mkdir` is read-only). The whole box is capped at 2 GiB and page cache is
     charged there, so the "cache competes with anon" mechanism is present, but
     the threshold is not the production one.
  2. **No `drop_caches`** (no root). Page cache was whatever the run left, so
     the cold-cache worst case of October's *steady* run is not reproduced.
  3. **No JFR / per-job CPU attribution.** CPU is read from the process's own
     ticks, so it cannot be split by scheduled method the way October's was.
  4. **Intervals left at default** (sweep 360 s, prune 600 s), so the window
     holds two sweeps and one prune rather than October's longer series.

## Uncertain

- Whether the `SQLITE_BUSY` writer collisions are this sandbox's 0.4 vCPU or a
  real property of `main`. A run on the CX23 (2 vCPU) would settle it; the
  retention `DELETE` failing is the one that would matter in production.
- The 13.9 s boot seeding sweep is a cold-start number only; it is not a
  steady-state sweep cost and should not be read as a budget breach.
- read_bytes and majflt are the numbers most sensitive to the missing
  `drop_caches` and the shared sandbox cgroup; the ~0.01 MB/s quiet-idle figure
  is above October's 0.047 only in the sense that it is lower — both are at the
  floor of what `/proc/<pid>/io` can resolve.
