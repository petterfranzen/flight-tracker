# Phases 2 and 3 review (P3-R)

An independent reviewer reviewed `claude/coverage-gap-phase3` at 48f7b38 on 2026-10-12.

## Gates

| Gate | Result |
|---|---|
| `npm run build` | pass |
| `test:e2e` | Only load-flakes; each re-ran green. |
| `test:perf` | Only the known main-thread test failed. It fails on `main` here too. |
| `test:scenarios` | 5/5 |
| `mvn -B verify -Pwith-frontend` | 261 tests, 0 failures |
| Blackbox, defaults | 22 pass, 1 skip. The skip came from OpenSky answering 429, so no live aircraft. |
| Blackbox, mock provider on | 23/23 |

With the mock on, against live OpenSky for about 14 min, LANDED_INFERRED went to LANDED_CONFIRMED and then to AT_GATE (gate and terminal filled).

## Findings

- **Blocking:** none.
- **Should-fix** (P2-F and P3-F fix these):
  1. **P3: stale cached confirmation.** The gateway caches a FOUND result per (callsign, airport, UTC date) for up to 12 h. Nothing checks that its `actualOn` falls after the aircraft's last report, so an earlier flight's confirmation can be applied to a later flight.
  2. **P3: endless re-polling.** A landed aircraft that has no gate keeps being asked every 5 min while it stays visible, which burns the provider budget.
  3. **P2: volume.** About 49 rows/min, roughly 70k/day, about 20 MB/day, about 7 GB/year at 365 days. That is 3–6× the estimate. Short between-sweep gaps dominate.
  4. **P2: failed flush.** A failed flush (SQLITE_BUSY) drops the batch while the in-memory `open` and `inferredDone` state assumes it succeeded.
- **Nits:**
  - AIRBORNE labels after long gaps are ambiguous.
  - Labels skew AIRBORNE, because a landed aircraft that never reports again gets no label.
  - A `;` in a `schema.sql` comment.
  - `PollBackoff` honours a `Retry-After` of any length.
  - The scheduler pool equals the number of jobs.
  - There is no 60 s refetch for LANDED_CONFIRMED.
  - Three config keys are missing from the README.
- **Real-provider readiness:**
  - AeroDataBox fits the SPI. It needs a per-provider monthly budget and units per call.
  - Swedavia (per airport, continuation token) needs an SPI batch mode: one airport page caches many flights. Design this when the provider is chosen.

## Verdict

- Phase 2: ready (fix 3 and 4).
- Phase 3: ready after fixes 1 and 2.
