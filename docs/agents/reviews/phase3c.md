# Phase 3c review (P3c-Rev): AeroDataBox provider and credit link, PR #125

An independent reviewer reviewed `claude/coverage-gap-phase3c-aerodatabox` at be1a08c on 2026-10-12.

## Gates

| Check | Result |
|---|---|
| Backend `mvn -B verify` | 418 tests, 0 failures |
| Frontend build | ok |
| `coverage-status.spec.ts`, 3 repeats at 4 workers | 81 passed |
| `cloud-init.yaml` drift | clean |
| Secrets | none |

## Findings

- **Blocking:** none can exceed the 400-unit/month free plan. The caps are 380/month and 14/day, charged before each call and written through to `app_state`.
- **Should-fix** (P3c-F fixes these). These waste the 14/day budget:
  1. **No recheck memo for per-flight providers.** An `Arrived` flight with no gate is re-asked every 5 min for the 45-min gate wait, 18 units for one flight. `Approaching` drains the day in 35 min. An unknown callsign costs 2 units every 15 min.
  2. **Unusable callsigns are charged anyway.** An unusable callsign is charged 2 units before the provider returns NOT_FOUND without calling.
  3. **"Not found" errors are retried.** 400/404/422 are treated as FAILED: not cached, and the same head candidate is retried first.
  4. **No refunds on failed calls.** THROTTLED and connection-level FAILED keep their charge.
- **Nits:**
  - An `IOException` while reading the body is read as NOT_FOUND.
  - The operator rank beats time distance in entry selection.
  - Retry-After parsing is duplicated.
  - The backend dossier label shows the raw provider id.
  - The spec's `open()` helper doesn't use `waitForMapReady` (pre-existing).
- **Sound:**
  - precedence (a locked-out Swedavia is not "enabled", so AeroDataBox covers its airports);
  - the time parser and mapping;
  - attribution (link, `rel`, no `innerHTML`, tokens);
  - `mayStoreLongTerm()` gating of training labels, and no other long-term storage.

## Verdict

Mergeable on cap safety, but fix 1–3 first so the 14/day budget covers real flights.
