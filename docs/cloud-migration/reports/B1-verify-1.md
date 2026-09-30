# Gate B1 verification — frontend-vanilla

Verified branch: `feat/cm-frontend` @ `3735033` (checked out detached, since
the branch ref itself was locked to another concurrent worktree at
verification time; content is identical).

## Result: PASS

## Checklist

- [x] `grep -rn "react" frontend/package.json frontend/src` → empty (confirmed, exit 1 / no matches).
- [x] `npm run build` clean (`tsc -b && vite build`, no errors) — confirmed on a fresh `npm ci`.
- [x] `npm run test:e2e` all green — 17/17 passed in 41.1s (matches claim exactly), including
      `production-build.spec.ts` against a real `vite preview` production build.
- [x] Spec edits listed and justified — only `frontend/tests/helpers.ts` changed under
      `frontend/tests/**` (confirmed via `git diff --stat feat/cloud-migration...3735033 --
      frontend/tests/`); diffed in full, matches the claim exactly: `__findLeafletMap` now reads
      `container._leaflet_map` (set in `frontend/src/map/map.ts:86`) instead of walking the React
      fiber tree. No other test file touched.
- [x] Bundle sizes before/after reported and target-miss explanation verified (see below).
- [x] Manual smoke coverage confirmed by reading spec titles — pan (marker-position.spec.ts
      "stays pinned ... across a pan"), zoom-to-clusters (clustering.spec.ts, both tests), select
      aircraft (marker-position.spec.ts, airport-search.spec.ts dossier), route drawn
      (marker-position.spec.ts asserts `path.route-line` via `getRoutePathScreenPoints`),
      favourites persist (favorites.spec.ts, full round trip incl. removal), mobile viewport
      (mobile-layout.spec.ts, real 390×844 viewport with FAB/bottom-sheet assertions). Spec file
      list is byte-identical to the pre-port baseline (`1d5868c`) — no coverage removed.
      **Gap (pre-existing, not introduced by this branch):** no spec clicks the actual theme-toggle
      UI control and asserts a resulting change; `basemap-reference-shots.spec.ts` and
      `production-build.spec.ts` only seed theme via `localStorage.setItem(...)` in
      `addInitScript`, and the former is a non-assertion screenshot capture. This gap already
      existed on `feat/cloud-migration` (same spec file list) so it is not a regression from the
      port, but it means "theme toggle" isn't independently verified as a UI interaction by this
      suite. Non-blocking for B1, flagged as a concern.

## Bundle-size explanation: verified — yes

Rebuilt both commits from a clean `npm ci` and measured gzip with the same method
(`gzip -c <file> | wc -c`, default level, matching Vite's own reported gzip which uses this same
default compression):

- Baseline (`1d5868c`, pre-port, React): `index-CohUKAMv.js` gzip = **102,645 B** (exact match to
  claim); `DefaultAirports-Ce97ePnO.js` gzip = **23,828 B** (exact match to claim). Combined =
  126,473 B (exact match to claimed "app JS excl. MapLibre chunk 126,473B").
- After (`3735033`, vanilla): `index-DSsXYaFk.js` gzip = **58,403 B**; `defaultAirports-DxrAUOXK.js`
  gzip = **23,817 B**. Combined = **82,220 B**, vs. the claimed 83,979 B — off by ~1,759 B (~2.1%
  lower than claimed). Minor measurement discrepancy, not material to the conclusion (cause not
  determined — possibly a different node/esbuild patch version at claim time; not reproduced here
  despite using the same `npm ci` lockfile). Direction and magnitude of the claim are correct either
  way (the port did **not** meet the 60KB gzip target).
- Independently measured Leaflet's own footprint: `node_modules/leaflet/dist/leaflet.js` (the
  prebuilt minified UMD bundle actually pulled in) gzip = **42,661 B**, matching the claimed
  "~42KB" closely.
- `defaultAirports` chunk gzip (23,817–23,828 B measured either side) matches the claimed
  "~23.5KB" airport-dataset figure closely.
- Leaflet (~42.7KB) + airport dataset chunk (~23.8KB) = **~66.5KB gzip**, which alone exceeds the
  60KB target before counting any of the ported application code. This independently confirms the
  explanation: the 60KB target was structurally unreachable without dropping Leaflet or the airport
  dataset from the gzip-measured surface, neither of which was in scope for B1. The remaining
  app-code contribution (58,403 − ~42,661 ≈ 15.7KB within the index chunk) is in the same
  ballpark as the claimed "~18KB", the residual gap plausibly coming from `maplibre-gl-leaflet`'s
  small glue layer and other app code that also lands in that chunk.

**Conclusion: the bundle-size miss and its explanation check out.** Not grounds for failing the
gate per the orchestrator's own instructions.

## Spot-checks beyond the checklist

- `frontend/src/api/flightApi.ts` diffed against `feat/cloud-migration`: confirmed the diff is
  scoped entirely to `subscribeLiveFeed`'s body (reconnect with capped exponential backoff
  1s→30s via `WS_RECONNECT_MIN_MS`/`WS_RECONNECT_MAX_MS`, plus `isFlightPosition` shape-filtering
  of keepalive frames). Exported signature (`subscribeLiveFeed(onPosition) => () => void`)
  unchanged. No other export in the file is touched by the diff.
- `frontend/src/ui/flightSearch.ts` bug fix (hover-triggered full-list-rebuild dropping a
  Playwright click-after-hover): read in full. `resultRow`'s `onMouseenter` now only toggles
  `flight-search-option--active` / `aria-selected` on existing `<li>` nodes via `setActiveRow`
  instead of calling the list-rebuilding `renderResults()`. This is a legitimate fix — Playwright's
  `.click()` performs a real hover-then-click sequence, and replacing the DOM node under the
  pointer mid-sequence would indeed lose the subsequent click — not a workaround papering over a
  deeper issue.
- `frontend/src/ui/defaultAirports.ts` bug fix (`keyboard: false` on airport markers): read in
  full. Matches Leaflet's documented `Map.Keyboard._panOnFocus` behavior (auto-pans on any DOM
  focus a tabbable element receives, including via mousedown) and the marker's 12×12 DivIcon with
  overflowing children is a plausible trigger for the described bounds-check misfire. The fix is
  narrowly scoped (airport markers only; aircraft/cluster markers keep keyboard focus) and the
  trade-off (airports lose Tab-key reachability, remain mouse/touch-clickable) is explicitly
  documented in the code comment, not hidden. Reads as a genuine, well-reasoned fix.
- `frontend/src/main.ts` (537 lines, houses the fetch/reconcile/selection lifecycle formerly in
  `FlightMap.tsx`) was read in full and spot-checked against
  `docs/cloud-migration/reports/B1-behaviour-inventory.md`'s claims: sequence-guarded live fetch
  (`liveRequestSeq`), stale-entry merge guard (`isNewer`), cluster vs. individual fetch branching
  at `CLUSTER_FETCH_MAX_ZOOM`, `startCycle`/`restartFetchCycleTimers` matching
  `FETCH_INTERVAL_MS`/`FETCH_STOP_MS`/`DIALOG_STOP_MS` semantics including the dialog timer's
  rate-limited/success/network-error branches, per-selection effect sequencing
  (`selectionEffectSeq`), history fetch with `legStartAt` retroactive trimming, priority poll, and
  WS subscribe wiring with the same `isNewer` guard — all consistent with the inventory's claims.
  Not every single inventory line item was independently re-derived from the original
  `FlightMap.tsx` given verification time constraints, but no discrepancy was found in what was
  checked.
- `frontend/Dockerfile` and `frontend/nginx.conf`: confirmed zero diff against
  `feat/cloud-migration` (untouched, as claimed; correctly flagged for Phase M deletion rather than
  deleted now).
- `frontend/package.json`, `frontend/vite.config.ts`, `frontend/tsconfig.json`: diffed in full —
  changes are exactly the claimed React-toolchain removal (react/react-dom/react-leaflet/
  @types/react*/@vitejs/plugin-react dropped; `jsx` compiler option removed; `react()` Vite plugin
  removed, rest of vite config's MapLibre-worker handling untouched).

## Out-of-scope edits

None. `git diff --name-only feat/cloud-migration...3735033` shows changes confined to `frontend/**`
plus exactly one new file outside it: `docs/cloud-migration/reports/B1-behaviour-inventory.md`
(the expected B1 deliverable doc). No secrets, no TODO/FIXME/XXX left in the diff
(`grep -ni "TODO\|FIXME\|XXX\|secret\|password\|api.key"` over the full diff: no hits).

## Concerns (non-blocking)

1. Theme-toggle UI interaction has no dedicated assertion-based Playwright test (pre-existing gap
   inherited unchanged from the Phase 0 baseline, not introduced by this port).
2. Airport markers lose Tab-key keyboard reachability as a side effect of the
   `keyboard: false` fix in `defaultAirports.ts`. This is a real, documented trade-off rather than
   an oversight, but is worth someone consciously accepting as an accessibility regression for
   ~878 airport markers (mouse/touch click is unaffected).
3. The "after" bundle-size total I measured (82,220 B gzip) is ~2.1% below the claimed 83,979 B.
   Doesn't change the pass/fail conclusion (target still missed either way, explanation still
   holds), but the implementing agent's exact figure couldn't be reproduced bit-for-bit from a
   clean `npm ci` + build in this environment.
