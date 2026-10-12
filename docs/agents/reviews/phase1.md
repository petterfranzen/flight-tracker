# Phase 1 review (P1-R)

An independent reviewer (not the author) reviewed `claude/beautiful-thompson-afahki` at 4cd1944 against `origin/main` on 2026-10-12.

## Gates

| Command | Result |
|---|---|
| `npm run build` | pass |
| `npm run test:e2e` | 111 pass, 3 fail. The failures are `map-zoom`, `route-estimate` and `view-cache`, and all three pass when re-run alone (load-flakes). The new `coverage-status.spec.ts` passed 13/13. |
| `npm run test:perf` | 1 pass, 1 fail ("never blocks the main thread > 200 ms": 254–273 ms). **Pre-existing:** it fails on pristine `origin/main` too (259 ms), because of software WebGL in the cloud box. |
| `npm run test:scenarios` | 5/5 |
| `mvn -B verify -Pwith-frontend` | 179 tests, 0 failures |
| Blackbox | 23/23 |

Live check against OpenSky:
- 11,434 markers: 9,270 LIVE, 1,405 ON_GROUND, 554 COVERAGE_LOST, 205 LANDED_INFERRED.
- All `/status` responses matched the contract.
- 372 aircraft lost at cruise had a maximum landing probability of 0.009, and none was inferred landed.
- Markers follow the estimate.

## Findings

- **Blocking:** none.
- **Should-fix, all being fixed in P1-F:**
  1. **Antimeridian.** Unwrapped dLon in the estimator `toXY` and in the frontend `coneRing`.
  2. **Marker and cone disagree.** The selected marker lags the 15 s cone refresh, because the marker comes from the 72 s `/live` poll.
  3. **Null altitude.** An aircraft with a null altitude, aligned with a runway, can be inferred landed (p 0.54).
  4. **Overflight freezes.** The threshold clamp freezes level overflights at the threshold.
- **Nits fixed in P1-F:**
  - 5: the poll is recorded before persist.
  - 6: the silence rule is dead for gapped aircraft.
  - 7: the UTC marker and radius format in the labels.
  - 10: log spam on `loadSnapshot` failures.
  - 11: nanosecond `at`.
  - 12: dead `findRawLatestLatLon`.
- **Follow-ups, not fixed:**
  - 8: LANDED_INFERRED aircraft stay visible on the 12 h airborne bound, not the 24 h landed window.
  - 9: the selected aircraft is not prioritised under the 300-per-tick snapshot cap.
  - 13: the status blackbox test only sees `live[0]`.
  - 14: the hard-coded fallback colour in `uncertainty.ts`, which follows the `route.ts` precedent.

## Verdict

Ready for the PR after the should-fix items.
