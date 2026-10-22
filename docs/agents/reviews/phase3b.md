# Phase 3b review (P3b-Rev): Swedavia provider, PR #124

An independent reviewer reviewed `claude/coverage-gap-phase3b-swedavia` at f99edf1 on 2026-10-12.

## Gates

The backend suite (`mvn -B verify`) ran 354 tests: 0 failures, 0 skipped. Playwright was not run, since there is no frontend change. CI covers it.

## Quota safety (the main concern)

The hard ceiling holds on every traced path:
- 300 units/day, so 300 × 30 = 9,000, which is below the free tier's 10,000/month even on a rolling window.
- 9,000 units/month.
- Calls ≥ 30 s apart (pacing set under a lock).
- Charged before the call. A limit can be overshot by at most 1 unit.
- Counters persist in `app_state`.

## Findings

- **Blocking:** none.
- **Should-fix** (P3b-F fixes these):
  1. **Unmatched candidates waste the daily budget.** They make the board refetch every 5 min, so 300/day runs out by early afternoon. After that, exhaustion is completely silent.
  2. **A failed first `app_state` read fails open.** The counter starts at 0 and the next write overwrites the real count. Corrupt and negative values are also parsed loosely.
  3. **Rejected keys burn units.** Both keys rejected costs 2 units per attempt, retried every ≤10 min. This is worse if Swedavia answers 403 when the quota is exhausted.
  4. **A skipped board fetch ends the whole tick**, so later candidates miss free matches against fresh cached boards.
- **Nits:**
  - The two key attempts run back to back.
  - Midnight board-date edge cases need documenting.
  - `BoardEntry.flightNumber` is unused.
  - `PollBackoff` uses `Instant.now()` (pre-existing).
  - The README env-var naming needs a note.
  - Add DST boundary tests.

## Verdict

Ready to merge once CI is green. Fix 2 and 3 before adding a live key; 1 and 4 are cheap enough to fix now too.
