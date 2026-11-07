# The popping harness: measuring planes that pop, not eyeballing them

"Planes pop." A marker disappears from a spot where the aircraft still is, or
a new one blinks in from nowhere, or a marker jumps backwards against its own
track. Every check of it so far was by eye, or by hand-scrubbing a screen
recording — slow, unrepeatable, and impossible to compare between two builds.

This harness makes popping a number. It records a fixture set of server
responses once, replays them into the app in order with the clock pinned to the
recording, drives the map with scripted gestures, reads what was actually drawn
after each step, and counts the popping events. The per-step table is printed
and the totals are checked against a budget, so a fix is a smaller number and a
regression is a red build.

- Fixture set: `frontend/tests/fixtures/popping/recording.json`
- Recorder: `frontend/scripts/record-popping-fixtures.ts`
- Harness: `frontend/tests/popping/replay.ts`
- Scenarios (tagged `@scenario`): `frontend/tests/popping.spec.ts`

## Running it

```bash
cd frontend
npm run test:scenarios          # every @scenario suite, one worker (this one included)
npx playwright test tests/popping.spec.ts --workers=1        # just this one
```

It is a normal `@scenario` suite: CI runs it in the same serial step as the user
journeys. The scenarios are deliberately short — software WebGL on CI is slow —
so each is a handful of recorded ticks. Under contention (`--repeat-each=5
--workers=4`) it should hold; the numbers move a little with timing, which is
what the budget's headroom is for.

## What is recorded

`recording.json` is produced by

```bash
node --experimental-strip-types scripts/record-popping-fixtures.ts
```

(Node 24 strips the types itself; no build step.) It records, for three minutes
at one tick every two seconds:

- **the fleet roster** once — identity plus the marker fields the bulk
  `/api/flights/live` response and the WebSocket frames carry (`LiveMarker`);
- **every aircraft's position per tick** — what `/api/flights/live` returns for
  the Stockholm bounding box, what `/api/flights/live/overview` thins out of it
  at zooms 6–10, and the WebSocket frames: one `LiveFrame` per aircraft per
  tick, filtered to the viewport the app last reported, exactly as
  `LiveFeedBroadcaster` pushes them. The replay derives the frames from the same
  recorded positions rather than storing them twice;
- **`/api/flights/{icao24}/status`** samples for the candidate planes, and a
  40-minute **history** per candidate (the trail).

### Where the data comes from

The sandbox an agent runs in has no route to the live backend, so the source is
the scenario suite's own simulated world (`frontend/tests/scenarios/world.ts`):
~230 airliners on real headings out of Arlanda, Schiphol and Kalmar, which every
existing scenario already treats as the backend. The recorded shapes are the
server's (`FlightController` / `LiveMarker.java`). It is public ADS-B territory,
so nothing here needs anonymising — but it is simulated, not captured, and the
`meta.source` string in the fixture says so. Pointing the recorder at a real
server (a route-interception capture against `BASE_URL`) would be a drop-in
change to the same fixture shape when one is reachable.

## How the replay works

`startReplay(page, testInfo)`:

- pins the page clock to the recording's epoch (`page.clock.install`), so the
  replayed timeline lines up with the app's own `Date.now()` — `observedAt`
  values, the 2-hour dimming rule — and nothing depends on when the test runs;
- answers every REST endpoint from the *current* tick, in the server's own
  shapes: markers for `/live` (filtered by the requested bbox), one plane per
  cell for `/overview`, full positions for `/{icao24}/live`, `TrackStatus` for
  `/{icao24}/status`, history from the recorded points;
- pushes each tick's WebSocket frames on `tick()`;
- waits until the app has applied the tick (`waitApplied`) before a step is
  read, so a request landing a moment late cannot by itself change the numbers.

`tick()` advances one recorded tick. `step(name)` reads the map and returns the
numbers for that moment.

## The numbers

After every step, `renderedPlanes()` (the map's own plane layers, not DOM) is
compared with the recorded truth for the current tick:

| Signal | Meaning |
| --- | --- |
| **vanished** | A plane was drawn at the previous step, is gone now, the view did not move, and its recorded position is still inside the drawn area. It should still be there: the pop by eye. |
| **appeared** | The mirror image: a plane joined the drawn set while the view was still, and it was already inside the drawn area at the previous step. |
| **backwards** | A plane drawn at both steps whose drawn position moved *against* its own heading by more than `BACKWARDS_TOL_DEG` — a stale cached position (see #53). |
| **sel off°** | The selected plane's marker away from the end of its drawn trail by more than `TRAIL_TOL_DEG`. Budgeted as the **worst distance in degrees** (`BUDGET.selectedOffTrailDeg`), not as a count of steps: the count depends on the environment (CI saw the marker behind its trail on 7 of 8 steps, the sandbox on 3 of 8, both at the same ~0.0045° = one 2 s tick of flight), so a count budget would either be toothless or red on a different machine. A real jump is orders of magnitude bigger than one tick. |

The declared-move threshold is `STILL_DEG`: the view counts as still when the
centre moved under ~2 km and the zoom did not change. A step after a gesture is
reported as `moved`, and only its `backwards` / `sel off°` can be read; the
vanished/appeared counts only count on `still` steps, which is where the pop is.

## The budget

`BUDGET` in `frontend/tests/popping/replay.ts` is how many events a scenario
may rack up per run. It is set to the baseline measured on `main` (see #86) with
a little headroom, so the suite is a durable guard rail rather than a red build.
When #66 / #53 land, tighten it: the whole point is that the numbers go down and
stay down.

Two baselines are recorded, because the numbers depend on the machine. Sandbox,
one worker:

| scenario | vanished | appeared | backwards | sel off° (steps / worst) |
| --- | --- | --- | --- | --- |
| pan across dense traffic | 4 | 1 | 0 | 0 / - |
| zoom 7 to 9 and back | 1 | 2 | 0 | 0 / - |
| pinch in and out | 0 | 1 | 0 | 0 / - |
| select SAS120 then pan and zoom | 1 | 1 | 0 | 3 / 0.0045 |

GitHub Actions, `test:scenarios` (`--workers=1`):

| scenario | vanished | appeared | backwards | sel off° (steps / worst) |
| --- | --- | --- | --- | --- |
| pan across dense traffic | 4 | 1 | 0 | 0 / - |
| zoom 7 to 9 and back | 3 | 1 | 0 | 0 / - |
| pinch in and out | 0 | 2 | 0 | 0 / - |
| select SAS120 then pan and zoom | 1 | 1 | 0 | 7 / 0.0045 |

CI's opening overview at z7 drew 64 planes where the sandbox drew 102, so the
absolute counts are environment-dependent even when the popping is not; the
budgets are set from the worse of the two.

The three dead-reckoned scenarios below (#150) assert "0 planes moved backwards"
directly rather than going through a `BUDGET`: a single backwards move *is* the
bug, so there is no headroom to leave. Their baseline, sandbox, one worker,
measured on the merged #150 fix with
`npx playwright test tests/popping.spec.ts --workers=1 --timeout=300000`
(7 tests, 7.2 min):

| scenario | steps | vanished | appeared | backwards | worst back° |
| --- | --- | --- | --- | --- | --- |
| a plane never moves backwards when a cached view is redrawn during a pan | 4 | 0 | 0 | 0 | 0.0000 |
| the selected plane's estimate survives a cached view of the same report | 4 | 0 | 0 | 0 | 0.0000 |
| a plane never moves backwards while the view is idle | 5 | 0-10 (usually 0-1) | 0-22 (usually 0-3) | 0 | 0.0000 |

The idle scenario's drawn set is steady in some runs and churns a little on the
overview refresh in others. Re-measured on `main` (#175), sandbox, 12 runs
(`--workers=1` and `--workers=2`, repeated; a further run failed on a locator timeout and printed no
summary): vanished/appeared 0/0 (4 runs), 0/2 (2), 1/3 (3), 4/4 (2), 10/22 (1);
backwards 0 and worst back 0.0000 in every run. The earlier "9 vanished,
20 appeared" was one churny run like the 10/22 one, not the typical case: QA's
0/0 is within the normal range. The churn is not the pop; the pop is a plane
moving *against its own track*, and the count for it is 0. The #150 run also reproduced the four `BUDGET` baselines
within their headroom (vanished 4/3/0/1, appeared 1/1/1/1, backwards 0
throughout, the selected plane 2 steps at 0.0045°): the counts move a little
with timing, the no-backwards claim does not. CI is the authority for the
repeated run.

### A server that dead-reckons

`startReplay(page, testInfo, { deadReckonMs })` makes the mocked server behave
like the real one: an aircraft's `observedAt` only advances when a *report*
lands (every `deadReckonMs`) while the position it returns keeps advancing with
the tick. Two snapshots of the same report therefore share `observedAt` with
different positions, the older one behind — the case #53/#97 is about, and one
the tick-per-report shape cannot reproduce (every snapshot gets a new
`observedAt`, so the older position loses on its own). Three scenarios use it:
"a plane never moves backwards when a cached view is redrawn during a pan" and
"the selected plane's estimate survives a cached view of the same report" (both
read below with `h.advance()` / `h.step(name, false)`), and "a plane never moves
backwards while the view is idle" — the #150 case, where the reports land
unprompted and the view never moves at all.

`startReplay(page, testInfo, { deadReckonMs, rawFrames: true })` additionally
makes the WebSocket frames carry the aircraft's **raw** last report, the way the
backend really pushes it (`LiveFrame.of`), while `/live` and `/live/overview`
keep serving the dead-reckoned display — so the two payloads of one report
disagree by several km, which is what the idle scenario measures. Unset, a frame
carries the same dead-reckoned position the REST endpoints do, the two never
disagree, and the idle reversion cannot show (the shape #53/#97's baselines
were recorded on).

Reading those: `h.advance()` moves to the next tick without waiting for the app
to settle, and `h.step(name, false)` reads what is drawn without waiting for it
to match the tick's recorded truth — both for a frame that is deliberately not
the tick's own (a cached view just redrawn during a pan, held still by pausing
the clock before it).

## Adding a scenario

Copy a block from `popping.spec.ts`, drive the map with `drag` / `wheelZoom` /
`pinch` / `jumpTo`, sprinkle `h.tick()` + `h.step()` (use `hold()` for rounds
with the view still — that is where the disappeared/appeared counts accrue),
then call `report(name, h)`. The fixture already holds minutes of ticks.
