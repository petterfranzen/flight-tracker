# Plane-layer render profile, November 2026

Profile of `renderAircraftLayer` (`frontend/src/main.ts`) with the declutter pass
it calls (`frontend/src/map/declutter.ts`) and the layer it feeds
(`frontend/src/map/planes.ts`), on `task/183-perf-planes` over `main` at
`b6de0b0`. It answers section9-hq#183: what does the pass cost at 500-3,000
planes, where does the time go, and what does the perf suite guard.

**Measured** means a number from the run described under *Method*. This sandbox
is **0.4 vCPU** (cgroup `cpu.max` = 40000/100000) with a **2 GiB** cap and other
agents sharing it, and the basemap is software WebGL. Two runs of the same size
here differ by more than 2x, so read the *shares* and the before/after of the
pure function, not the absolute milliseconds. CI is the authority.

## Answer

1. **The pass scales with the planes the view holds, not with the loaded fleet.**
   `renderAircraftLayer` filters to the padded viewport before it does anything
   per-plane, so the cost is driven by candidates on screen. The fixture below
   deliberately puts all N in one z10 viewport to measure the worst case; real
   traffic at z10 shows a fraction of a worldwide fleet.
2. **Two costs dominate the call: screen projection and declutter.**
   `map.project` per candidate (the projection loop) is the largest part in the
   2,000-3,000-plane rows (~30-70 % of the call's own time), and
   `pickNonOverlapping` is next (~10-60 %). Everything else (`findShadowedIds`,
   the drawn filter, `planeLayer.update`) is single-digit milliseconds.
3. **Declutter was the fixable one.** `pickOnce` allocated a `Placed[]` array for
   every candidate in every pass, and its spatial grid was an integer-hashed
   `Map`. Both are now one reused buffer and a flat array indexed by cell. The
   drawn set is unchanged (A/B on 40 randomized fleets across the new-key, held,
   widening and displacement paths), and a 41-sample alternating median on this
   box loses **~17 %** off the new-key (zoom) pass and **~4 %** off the held
   (pan) pass.
4. **`setData` never fires per frame.** The layer re-sends only when the drawn
   set's `icao24/lat/lon/heading/known/callsign/dimmed/watched` key changes. The
   idle window of the 2,000-plane perf case measured **0** additional `setData`
   calls.

## The profile

One `node scripts/profile-planes.mjs 500 1000 2000 3000` run on this branch.
`ms/call` is `renderAircraftLayer` wall time; `declutter` and `projection` are the
totals of those parts over the phase divided by the phase's render calls; shares
are of the phase's total render time. `drawn` is what `renderedPlanes()` saw at
the end of the phase. An idle window only counts renders that happened inside it
(the app is idle, so it is often zero).

| N | phase | render calls | ms/call | declutter ms/call | declutter share | projection ms/call | setData | drawn | frames dropped |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 500 | idle | 1 | 83.5 | 15.8 | 18.9 % | 59.4 | 1 | 4 | 0 |
| 500 | pan | 3 | 67.1 | 6.8 | 10.1 % | 6.8 | 0 | 129 | 3 |
| 500 | zoom | 6 | 21.4 | 6.3 | 29.3 % | 1.3 | 4 | 66 | 0 |
| 1,000 | idle | 1 | 84.0 | 18.3 | 21.8 % | 35.8 | 1 | 4 | 0 |
| 1,000 | pan | 3 | 55.0 | 13.8 | 25.0 % | 15.0 | 0 | 176 | 0 |
| 1,000 | zoom | 6 | 62.8 | 36.8 | 58.6 % | 23.1 | 5 | 243 | 0 |
| 2,000 | idle | 0 | - | - | - | - | 0 | 177 | 0 |
| 2,000 | pan | 3 | 141.9 | 87.2 | 61.4 % | 43.8 | 0 | 177 | 3 |
| 2,000 | zoom | 7 | 94.3 | 30.0 | 31.8 % | 30.6 | 6 | 205 | 0 |
| 3,000 | idle | 2 | 241.9 | 98.6 | 40.7 % | 129.2 | 1 | 4 | 0 |
| 3,000 | pan | 3 | 96.2 | 31.4 | 32.6 % | 42.0 | 0 | 204 | 0 |
| 3,000 | zoom | 6 | 122.4 | 45.7 | 37.3 % | 64.7 | 5 | 224 | 0 |

The **0 `setData` on every pan row** and the small `setData` counts on the zoom
rows are the "never per frame" property measured end to end: three pans at z10
re-render the layer without re-sending the source at all.

## Method

- **Fixture:** `frontend/scripts/profile-planes.mjs` (this branch) launches the
  bundled Chromium with software GL at 1280x800 against the dev server on 5174,
  stubs every API route (a grid of N planes in a 0.5 deg box around London, so
  all of them are in the z10 viewport), stubs the basemap tiles empty and the
  `ws/live` socket, then drives pan (three `setView`s), zoom (across the
  8-9-10 thresholds) and idle (2 s with no viewport change), reading
  `window.__flightPerf`.
- **Instrumentation:** `frontend/src/map/perf.ts` — always on, one
  `performance.now()` pair per render and per declutter pass, one counter per
  `setData`. `main.ts` wires it up and exposes it as `window.__flightPerf`;
  `planes.ts` counts the two sources. The overhead is one pair per render.
- **Frames dropped:** a `requestAnimationFrame` loop records each interval;
  "dropped" counts intervals longer than twice the run's median.
- **Declutter before/after:** throwaway `ab-declutter` scripts (removed before
  commit) imported the previous `declutter.ts` and the new one, ran
  `pickNonOverlapping` on 40 seeded fleets across all key paths and asserted the
  drawn set is identical, then took a 41-sample alternating median for the
  timing (new key 76.09 -> 63.02 ms; held 16.99 -> 16.35 ms).

## The 2,000-plane perf guard

`tests/perf.spec.ts`, tagged `@perf`: `mockDenseFleet(page, 2000)` (a new helper
that serves a dense fleet the app's own `?mockPlanes=N` cannot — its fleet is
worldwide), `waitForMapReady`, z10, then the same pan/zoom/idle drive. It asserts:

- the drawn set re-sent at least once while it changed,
- **zero** additional `setData` during an idle window with the socket stubbed,
- milliseconds per `renderAircraftLayer` under `120 ms x cpuSlowdown`.

On this sandbox: 10 render calls, **164 ms/call**, max 390 ms, declutter
75 ms/call, `setData` 3, idle `setData` 0, slowdown 4 -> budget 480 ms.
On CI (green on the pushed head, 2026-11-07): **3.95 ms/call**, max 8.2 ms,
declutter 2.23 ms/call, `setData` 4, idle `setData` 0, slowdown 3.73 -> budget
447 ms. The margin is deliberately generous because hardware and software-WebGL
runners differ by two orders of magnitude here; a local `test:perf` run in a busy
container can fail for load reasons alone. CI is the authority.

## Uncertain

- **The absolute milliseconds.** 0.4 vCPU shared with other agents; two runs of
  one size differ by more than 2x (the earlier pre-fix runs measured 42.6 and
  16.7 ms/call for the same 1,000/2,000-plane pan). Only the shares and the
  before/after A/B of the pure function are trustworthy.
- **The projection cost is named, not fixed.** It is MapLibre's own per-candidate
  transform; there is no batch API to call instead.
- **Why the budget is loose.** CI measured 3.95 ms/call against a 447 ms budget;
  the sandbox measured 164 ms/call. The budget has to clear the sandbox's load
  noise and CI's own variance without letting the ~1 s regression this suite was
  written for pass.
