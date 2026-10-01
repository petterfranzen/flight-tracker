## frontend-vanilla · B1 · PASS

**Branch / last commit:** `feat/cm-frontend` @ `3735033` (2 commits on top of `feat/cloud-migration`@`1d5868c`: `d1177d6` remove React toolchain, `3735033` port FlightMap and friends to vanilla TypeScript).

**Setup note:** same worktree/branch mismatch as A1 — the worktree wasn't pre-created on `feat/cm-frontend`. The agent created it from `feat/cloud-migration` in-place.

**What changed (by file group):**
- `frontend/package.json`, `package-lock.json`, `vite.config.ts`, `tsconfig.json`, `index.html`: removed react/react-dom/react-leaflet/@types/react*/@vitejs/plugin-react; dropped jsx compiler option and Vite react plugin; entry script now `/src/main.ts`. Kept leaflet, maplibre-gl, @maplibre/maplibre-gl-leaflet, Vite, TypeScript, @types/leaflet.
- Deleted: `src/App.tsx`, `src/main.tsx`, `src/components/*.tsx` (10 files). CSS kept, imported from new owning modules.
- New: `src/state/store.ts` (48-line typed observable store), `src/state/appState.ts`, `src/map/{map,markers,clusters,route,maplibreBasemap}.ts`, `src/ui/{h,bootScreen,dock,flightSearch,favoritesPanel,legend,themeToggle,scaleBar,defaultAirports,dossierPanel,resumeDialog}.ts`, `src/main.ts`.
- `src/api/flightApi.ts`: `subscribeLiveFeed` body only — capped exponential-backoff reconnect (1s→30s) and keepalive-frame filtering (B1.5). Exported signature unchanged; every other export byte-identical.
- Unchanged, as instructed: `types/flight.ts`, `favorites.ts`, `theme.ts`, `graticule.ts`, `worldMapData.ts`, `cyberpunkMapStyle.ts`, `api/mockFleet.ts`, all `.css`.
- `frontend/Dockerfile`, `frontend/nginx.conf`: untouched (Phase M deletes them).

**Contract impact:** one `tests/**` edit, required and narrow, within the PLAN's own carve-out.
- `frontend/tests/helpers.ts`: `__findLeafletMap` no longer DFS-walks the React fiber tree — reads the map instance off a `_leaflet_map` property `map/map.ts`'s `createMap()` stashes on the Leaflet container. This is exactly the "reaches into React internals" carve-out in PLAN §3 contract 5. No other test file changed; every spec's selectors, text, ARIA, timing expectations untouched.
- `subscribeLiveFeed`'s internal behavior changed (reconnect/keepalive-filter) but signature is identical — flagged by the agent as worth a quick confirm this reading is correct (B1.5 explicitly required this behavior).
- No HTTP/WS wire-format changes, no DOM id/class/ARIA changes, no `flightApi.ts`/`types/flight.ts` exported-signature changes.

**Tests run + result:**
- `tsc -b` clean, strict. `npm run build` clean.
- `npm run test:e2e`: **17/17 passed**, ~41s, including `production-build.spec.ts` against a real `vite preview` build.
- `grep -rn "react" frontend/package.json frontend/src` → empty.

**Two real bugs found and fixed during the port** (not present in React version, specific to new DOM construction):
1. `ui/flightSearch.ts`: hovering a search result triggered a full list rebuild; a real Playwright `.click()` hovers before clicking, and replacing the DOM node mid-gesture dropped the click. Fixed by updating existing rows' active state in place.
2. `ui/defaultAirports.ts`: airport markers now set `keyboard: false`. Leaflet's `Map.Keyboard._panOnFocus` auto-pans on any DOM focus (including mousedown-given focus, not just Tab) and mismeasured these tiny 12×12 DivIcons as off-screen, panning the marker out from under the click. Confirmed via captured JS stack trace. Aircraft/cluster markers unaffected, keep keyboard focus; airports remain fully mouse/touch-clickable — only Tab-key reachability traded away.

**Numbers (bundle sizes, gzip):**

| Asset | Baseline (React) | New (vanilla) |
|---|---:|---:|
| `index-*.js` | 102,645 B | **59,894 B** |
| `defaultAirports-*.js` | 23,828 B | **24,085 B** |
| **App JS excl. MapLibre chunk** | **126,473 B (123.5 KB)** | **83,979 B (82.0 KB)** |
| `maplibreBasemap-*.js` (lazy, unchanged content) | 258,701 B | 265,585 B |

**Target (PLAN §6 B1.7: ≤60 KB gzip) not met — flagged for renegotiation, not silently missed.** Why:
- Leaflet itself (kept per PLAN, unchanged) gzips to ~42 KB alone through this same Vite/esbuild pipeline.
- `defaultAirports-*.js` (~23.5 KB) is mostly the 878-airport dataset (`worldMapData.ts`, unchanged per PLAN), not framework code.
- Leaflet + airport chunk alone (~65.5 KB) already exceed 60 KB before any app wiring/UI code.
- What the agent actually controls (main.ts + 9 UI modules + 4 map modules + store + glue) is roughly **~18 KB gzip** — the real comparison point against the old FlightMap.tsx + 9 components + react-leaflet glue.
- Still cut total app JS **35.6%** (126.5 KB → 82.0 KB), the full win available at this layer.
- Agent's suggested resolutions (orchestrator/Petter's call): (a) redefine target as "index chunk only" (met: 59,894 B < 60 KB, barely); (b) accept ~82 KB as the realistic floor given Leaflet + full airport dataset are both explicitly kept; (c) revisit thinning/lazy-splitting `worldMapData.ts` (out of scope for B1 — touches a "keep unchanged" file).

**Needs from other agents:** none blocking. `isFlightPosition()` filter in `flightApi.ts` accepts anything with string `icao24`+`observedAt`, silently drops anything else — shape-agnostic to whichever keepalive frame A1 ships, no coordination strictly needed, but worth a sanity check once A1 lands.

**Files to delete in Phase M:** `frontend/Dockerfile`, `frontend/nginx.conf` (both present, untouched).

**Open risks:**
- Bundle-size target needs an explicit decision (see Numbers above), not a silent miss.
- Marker/cluster icon caching implemented, markers reused by `icao24`, heading applied via direct style mutation — but DOM updates are not explicitly batched into a single `requestAnimationFrame` callback per PLAN's general B1 guidance. Not a correctness issue (all 17 specs pass including marker-position/selection-race tests), matches or exceeds the original React version's DOM-churn characteristics, but flagging in case a future perf pass on a real ~15k-aircraft deploy wants it.
- `defaultAirports.ts`'s `keyboard:false` fix trades away Tab-key reachability for airport markers specifically. Not tested either way by the given specs.
- Did not run backend/blackbox suites (out of scope, no backend changes; confirmed this package needed no docker/nerdctl as the environment note predicted).

Behaviour inventory (every effect/timer/handler from the 1,760-line `FlightMap.tsx` plus all 9 former components, ticked off as ported): `docs/cloud-migration/reports/B1-behaviour-inventory.md`.
