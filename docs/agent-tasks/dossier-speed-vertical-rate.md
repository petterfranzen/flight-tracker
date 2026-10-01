# Show ground speed and vertical rate in the aircraft dossier

Supersedes PR #66, which targeted the deleted React `FlightMap.tsx`.

## Starting point
Branch `feat/dossier-speed-vertical-rate` already has the code, in one WIP commit:
- `SelectedPosition` widened with `velocityMs`/`verticalRateMs` (`frontend/src/types/flight.ts`)
- both `selectedPos` merges in `frontend/src/main.ts` initialise them to null
- **Speed** (km/h) and **Vertical rate** (signed m/s, one decimal, `+` for ≥ 0, `-0` normalised) rows in `frontend/src/ui/dossierPanel.ts`

It was written before PR #70 rewrote the live-position path in `main.ts`
(`positions` is now a `Map`; `applyLiveSnapshot` takes a list), and PR #71
changed the same file again (view cache: `applyCachedView`/`lastAppliedView`;
`renderAircraftLayer` now only renders aircraft inside the padded viewport),
so it conflicts there.

## Do
1. Rebase the branch onto `origin/main`. In `main.ts`, keep #70's and #71's
   structure and re-apply only the intent: wherever `selectedPos` is created from a
   `LiveMarker`, the three fields start as null.
2. Add a Playwright test in `frontend/tests/` using the existing mocked-API
   fixtures. It should select an aircraft and assert both rows: "—" before a
   full position arrives, then e.g. `833 km/h` and `+5.2 m/s` / `-3.0 m/s` / `+0.0 m/s`.
3. `cd frontend && npm run build && npm run test:e2e` passes, including `perf.spec.ts`.
4. Squash into one commit, force-push the branch (it's yours), and open a PR
   titled "Show ground speed and vertical rate in the aircraft dossier"
   saying it supersedes #66. Delete this brief in the same PR.
