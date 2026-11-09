import { expect, test } from "@playwright/test";
import {
  BUDGET,
  CENTRE,
  REC,
  tickTime,
  type Replay,
  type StepMetrics,
  boot,
  clickPlane,
  drag,
  jumpTo,
  pickCandidate,
  pinch,
  startReplay,
  wheelZoom,
} from "./popping/replay";
import { waitForMapReady } from "./helpers";

// Popping, measured. Every scenario replays the same recorded fixture set
// (tests/fixtures/popping/recording.json — see scripts/record-popping-fixtures.ts)
// through the app in order with the clock pinned to the recording, drives it
// with real gestures, and after each step reads what was drawn with
// renderedPlanes(). The per-step table is printed, and the totals are checked
// against BUDGET (documented in popping/replay.ts) — the baseline on main is
// in #86, and the whole point is that #66/#53's fixes drive these numbers down.
//
// Software WebGL on CI is slow, so the scenarios are short: a handful of
// recorded ticks each and seven to nine measured steps. The fixture holds
// minutes of ticks if a scenario ever needs more.

// Every scenario is independent: one over budget must not hide the others'
// numbers, so a run always reports a full baseline table.
// No video or trace: the evidence this test produces is the per-step table and
// screenshot, attached to the report — video/trace only add minutes to a slow
// software-WebGL run.
test.use({ viewport: { width: 1280, height: 800 }, hasTouch: true, video: "off", trace: "off" });

/** Rounds of tick + step with no gesture in between: the view is still, which is where popping shows. */
async function hold(h: Replay, rounds: number, name: string): Promise<void> {
  for (let i = 1; i <= rounds; i++) {
    await h.tick();
    await h.step(`${name} (hold ${i})`);
  }
}

/** Prints the scenario's table and fails if any signal is over budget. */
function report(scenario: string, h: Replay): void {
  const totals = (f: (s: StepMetrics) => number) => h.steps.reduce((a, s) => a + f(s), 0);
  const vanished = totals((s) => s.vanished.length);
  const appeared = totals((s) => s.appeared.length);
  const backwards = totals((s) => s.backwards.length);
  const offTrail = totals((s) => (s.selectedOffTrail ? 1 : 0));
  const offTrailMaxDeg = Math.max(0, ...h.steps.map((s) => s.selectedOffTrail?.offDeg ?? 0));

  // eslint-disable-next-line no-console
  console.log(`\n[popping] ${scenario}\n${h.table()}\n[popping] ${scenario}: ${h.summary()}\n`);

  expect(vanished, `${scenario}: ${vanished} planes vanished while the view was still (budget ${BUDGET.vanished})`).toBeLessThanOrEqual(BUDGET.vanished);
  expect(appeared, `${scenario}: ${appeared} planes appeared while the view was still (budget ${BUDGET.appeared})`).toBeLessThanOrEqual(BUDGET.appeared);
  expect(backwards, `${scenario}: ${backwards} planes moved backwards along their track (budget ${BUDGET.backwards})`).toBeLessThanOrEqual(BUDGET.backwards);
  expect(offTrailMaxDeg, `${scenario}: the selected plane left its trail by up to ${offTrailMaxDeg.toFixed(4)} deg on ${offTrail} step(s) (budget ${BUDGET.selectedOffTrailDeg} deg)`).toBeLessThanOrEqual(BUDGET.selectedOffTrailDeg);
  expect(h.pageErrors, `${scenario}: page errors`).toEqual([]);
}

test.describe("popping @scenario", () => {
  test("pan across dense traffic", async ({ page }, testInfo) => {
    test.setTimeout(240_000);
    const h = await startReplay(page, testInfo);
    await boot(page);
    await jumpTo(page, CENTRE.lat, CENTRE.lon, 8);
    await h.tick();
    await h.step("opened at z8 over Stockholm");

    await drag(page, -300, 0); // east, across the SAS cluster
    await h.tick();
    await h.step("panned east");
    await hold(h, 2, "panned east");

    await drag(page, 300, 60); // back west
    await h.tick();
    await h.step("panned back west");
    await hold(h, 2, "panned west");
    report("pan across dense traffic", h);
  });

  test("zoom 7 to 9 and back", async ({ page }, testInfo) => {
    test.setTimeout(240_000);
    const h = await startReplay(page, testInfo);
    await boot(page);
    await jumpTo(page, CENTRE.lat, CENTRE.lon, 7); // the thinned-out overview
    await h.tick();
    await h.step("opened at z7 (overview)");

    await wheelZoom(page, 2); // 7 -> 9, crossing CLUSTER_FETCH_MAX_ZOOM
    await h.tick();
    await h.step("zoomed to z9");
    await hold(h, 2, "z9");

    await wheelZoom(page, -2); // 9 -> 7, back across the swap
    await h.tick();
    await h.step("zoomed back to z7");
    await hold(h, 2, "z7 again");

    expect(await page.evaluate(() => (document.querySelector(".map-container") as unknown as { _flightMap: { getZoom(): number } })._flightMap.getZoom()), "back near z7").toBeLessThan(8.5);
    report("zoom 7 to 9 and back", h);
  });

  test("pinch in and out over the traffic", async ({ page }, testInfo) => {
    test.setTimeout(240_000);
    await page.setViewportSize({ width: 390, height: 844 }); // a phone, where pinching is the way to zoom
    const h = await startReplay(page, testInfo);
    await boot(page);
    await jumpTo(page, CENTRE.lat, CENTRE.lon, 8);
    await h.tick();
    await h.step("opened at z8 on a phone");

    const zoomOf = () => page.evaluate(() => (document.querySelector(".map-container") as unknown as { _flightMap: { getZoom(): number } })._flightMap.getZoom());
    const before = await zoomOf();
    await pinch(page, 2); // two fingers out: zoom in
    await h.tick();
    await h.step("pinched out");
    expect(await zoomOf(), "pinch out zoomed in").toBeGreaterThan(before);
    await hold(h, 2, "pinched in");

    await pinch(page, 0.5); // two fingers in: zoom back out
    await h.tick();
    await h.step("pinched back out");
    await hold(h, 2, "pinched out");
    report("pinch in and out", h);
  });

  test("select a plane, then pan and zoom away from it", async ({ page }, testInfo) => {
    test.setTimeout(240_000);
    const h = await startReplay(page, testInfo);
    await boot(page);
    await jumpTo(page, CENTRE.lat, CENTRE.lon, 9);
    await h.tick();
    await h.step("opened at z9 over Stockholm");

    const callsign = await pickCandidate(page);
    await clickPlane(page, callsign);
    await h.tick();
    await h.step(`selected ${callsign}`);
    await hold(h, 2, `selected ${callsign}`);

    await drag(page, -250, 120); // pan away from the selection
    await h.tick();
    await h.step("panned away");

    await wheelZoom(page, -2); // and zoom out
    await h.tick();
    await h.step("zoomed out from the selection");
    await hold(h, 2, "zoomed out");

    report(`select a plane (${callsign}) then pan and zoom`, h);
  });

  // The stale-cache pop (#53 / #97). The server dead-reckons, so an
  // aircraft's observedAt only advances when a report lands (here every 10 s)
  // while the position it returns keeps advancing with the tick. A view drawn
  // for the same report but fetched earlier is therefore *behind* the frame on
  // screen with the *same* observedAt, and merging by observedAt let that
  // older position overwrite the planes already drawn — they popped backwards
  // during a pan and snapped forward again when the fresh response landed.
  //
  // The clock is paused just before the pan back, so the viewport debounce (and
  // the refetch behind it) never fires and the cached frame stays on screen long
  // enough to be read — the same cache path a real pan takes, held still.
  test("a plane never moves backwards when a cached view is redrawn during a pan", async ({ page }, testInfo) => {
    test.setTimeout(240_000);
    const h = await startReplay(page, testInfo, { deadReckonMs: 10_000 });
    await boot(page);
    await jumpTo(page, CENTRE.lat, CENTRE.lon, 9);
    await page.clock.runFor(300);
    await h.step("opened at z9 over Stockholm");

    const callsign = await pickCandidate(page);
    await clickPlane(page, callsign);
    await page.clock.runFor(300);
    await h.step(`selected ${callsign}`);

    // Pan east to a second view that overlaps the first, a tick later but the
    // same dead-reckoned report.
    await jumpTo(page, CENTRE.lat, CENTRE.lon + 0.15, 9);
    h.advance();
    await page.clock.runFor(300);
    await h.step("panned east");

    // Pan back west: the first view is redrawn from its cache at once, behind
    // the frame on screen and with the same observedAt. Pause the clock first
    // so the debounced refetch cannot replace it before the step is read.
    await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 2_000);
    await jumpTo(page, CENTRE.lat, CENTRE.lon, 9);
    await page.clock.runFor(150);
    await h.step("panned back west", false);

    // eslint-disable-next-line no-console
    console.log(`\n[popping] dead-reckoned cache\n${h.table()}\n[popping] ${h.summary()}\n`);

    const backwards = h.steps.reduce((a, s) => a + s.backwards.length, 0);
    const worstBackDeg = Math.max(0, ...h.steps.flatMap((s) => s.backwards.map((b) => b.backDeg)));
    const offTrailMaxDeg = Math.max(0, ...h.steps.map((s) => s.selectedOffTrail?.offDeg ?? 0));
    expect(backwards, `${backwards} plane(s) moved backwards along their track (worst ${worstBackDeg.toFixed(4)} deg)`).toBe(0);
    expect(offTrailMaxDeg, `the selected plane left its trail by up to ${offTrailMaxDeg.toFixed(4)} deg`).toBeLessThanOrEqual(BUDGET.selectedOffTrailDeg);
    expect(h.pageErrors, "page errors").toEqual([]);
  });

  // The selected plane's estimate (#97, second half of #53's diagnosis).
  // moveSelectedToEstimate puts the marker on the status's dead-reckoned
  // position while keeping the report's observedAt, so a cached /live list of
  // that same report — drawn at once during a pan — compares equal and used to
  // overwrite the estimate: the marker snapped back while the trail stayed
  // ahead. The estimate's as-of (now) is newer than the cached list's, so it
  // survives.
  //
  // Timing-sensitive, and named honestly: a single run can pass even without
  // the fix, because the report's /live reconcile has to land while the
  // estimate is on screen. When it does bite, it is on the **panned east**
  // step — the reconcile of the same report overwriting the estimate, about
  // one tick (~0.0045 deg) of flight — not on the cached redraw at 'panned back
  // west' that the mechanism above describes. Run it repeated to see it; CI
  // retries a failure once (CLAUDE.md, "Writing tests that don't flake").
  test("the selected plane's estimate survives a cached view of the same report", async ({ page }, testInfo) => {
    test.setTimeout(240_000);
    const h = await startReplay(page, testInfo, { deadReckonMs: 10_000 });
    await boot(page);
    await jumpTo(page, CENTRE.lat, CENTRE.lon, 9);
    await page.clock.runFor(300);
    await h.step("opened at z9 over Stockholm");

    const callsign = await pickCandidate(page);
    const plane0 = REC.fleet.find((f) => f.callsign === callsign)!;
    const idx = REC.fleet.indexOf(plane0);
    /** The estimate: a tick ahead of the report /live carries, report's own observedAt. */
    const estimateAt = (): { observedAt: string; lat: number; lon: number } => {
      const report = Math.min(h.tickIndex, REC.ticks.length - 1);
      const ahead = Math.min(report + 1, REC.ticks.length - 1);
      return { observedAt: new Date(tickTime(report)).toISOString(), lat: REC.ticks[ahead].lat[idx], lon: REC.ticks[ahead].lon[idx] };
    };
    // Serve the estimate from the selected plane's status and its own poll, so
    // the marker sits on it whichever of the two lands last.
    await page.route(new RegExp(`/api/flights/${plane0.icao24}/status`), (route) => {
      const e = estimateAt();
      return route.fulfill({
        json: {
          icao24: plane0.icao24,
          state: "LIVE",
          confidence: null,
          source: "adsb",
          sourceKind: "observed",
          lastSeenAt: e.observedAt,
          lastSeenLat: e.lat,
          lastSeenLon: e.lon,
          estimate: { lat: e.lat, lon: e.lon, radiusM: 500, at: e.observedAt, landingProbability: 0 },
          landing: null,
          gate: null,
          terminal: null,
          confirmedAt: null,
        },
      });
    });
    await page.route(new RegExp(`/api/flights/${plane0.icao24}/live`), (route) => {
      const e = estimateAt();
      return route.fulfill({
        json: {
          id: 0,
          icao24: plane0.icao24,
          callsign: plane0.callsign,
          observedAt: e.observedAt,
          latitude: e.lat,
          longitude: e.lon,
          altitudeM: plane0.altitudeM,
          velocityMs: plane0.velocityMs,
          headingDeg: plane0.headingDeg,
          verticalRateMs: 0,
          onGround: false,
          agentSource: "opensky",
        },
      });
    });

    await clickPlane(page, callsign);
    await page.clock.runFor(300);
    const est = estimateAt();
    await h.step(`selected ${callsign}`);
    await expect
      .poll(
        async () => {
          const p = (await h.drawn()).find((x) => x.icao24 === plane0.icao24);
          return p ? Math.hypot(p.lat - est.lat, p.lon - est.lon) : 1;
        },
        { timeout: 5_000, message: "the marker sits on its estimate" },
      )
      .toBeLessThan(0.0005);
    const onEstimate = (await h.drawn()).find((p) => p.icao24 === plane0.icao24)!;

    // Pan east and let it land, then pan back west so the first view is redrawn
    // from its (older) cache while the marker is on the estimate.
    await jumpTo(page, CENTRE.lat, CENTRE.lon + 0.15, 9);
    h.advance();
    await page.clock.runFor(300);
    await h.step("panned east");

    await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 2_000);
    await jumpTo(page, CENTRE.lat, CENTRE.lon, 9);
    await page.clock.runFor(150);
    await h.step("panned back west", false);

    // eslint-disable-next-line no-console
    console.log(`\n[popping] selected estimate\n${h.table()}\n[popping] ${h.summary()}\n`);

    const selectedBackwards = h.steps.flatMap((s) => s.backwards).filter((b) => b.icao24 === plane0.icao24);
    expect(selectedBackwards, "the selected plane moved backwards along its track").toEqual([]);
    // The selected marker sits one tick of flight behind the end of its trail
    // on the selection step — the harness's own budget for that benign lag
    // (popping/replay.ts) — so this only rules out a real jump. The position
    // check below is the sharp one.
    const offTrailMaxDeg = Math.max(0, ...h.steps.map((s) => s.selectedOffTrail?.offDeg ?? 0));
    expect(offTrailMaxDeg, "the selected plane left its trail").toBeLessThanOrEqual(BUDGET.selectedOffTrailDeg);
    const drawn = (await h.drawn()).find((p) => p.icao24 === plane0.icao24)!;
    // Still on the estimate, not pulled back to the cached report's position
    // (a tick behind it).
    expect(drawn.lat, "the marker is still on its estimate").toBeCloseTo(onEstimate.lat, 5);
    expect(drawn.lon, "the marker is still on its estimate").toBeCloseTo(onEstimate.lon, 5);
    expect(h.pageErrors, "page errors").toEqual([]);
  });

  // The idle reversion (#150). Below CLUSTER_FETCH_MAX_ZOOM the map draws the
  // server's **dead-reckoned** position: /live/overview serves the last report
  // projected forward along its own track (EstimatedPositionService). The
  // WebSocket feed, though, pushes the **raw** report (LiveFrame.of, straight
  // off the persisted position). With the server dead-reckoning — a report every
  // 10 s, the position returned advancing with the tick, and `rawFrames` so the
  // frames carry the raw report the way the backend really does — the two
  // payloads of one report disagree by several km. A frame landing after a
  // refresh therefore used to pull the marker back to the raw report and the
  // next refresh snapped it forward: the aircraft alternated between two
  // positions with no new report and no interaction, measured on production as
  // planes reverting to a coordinate from two samples earlier.
  //
  // The view never moves after the opening jump, so this is the idle case; the
  // steps are read without waiting for the app to settle, because the whole
  // point is the frame that lands between two refreshes.
  test("a plane never moves backwards while the view is idle", async ({ page }, testInfo) => {
    test.setTimeout(240_000);
    const h = await startReplay(page, testInfo, { deadReckonMs: 10_000, rawFrames: true });
    await boot(page);
    await jumpTo(page, CENTRE.lat, CENTRE.lon, 6);
    // Walk into the middle of a report window: the server now answers with a
    // position several ticks ahead of the raw report the frames carry.
    for (let i = 0; i < 3; i++) {
      h.advance();
      await page.waitForTimeout(400);
    }
    await h.step("opened at z6, mid-window", false);

    // The overview refetch (OVERVIEW_REFRESH_MS = 10 s) draws the dead-reckoned
    // position for the report open right now.
    await page.waitForTimeout(11_000);
    await h.step("after the overview refresh", false);

    // The frames for that same report arrive: raw positions, the observedAt the
    // drawn marker already carries.
    for (let i = 0; i < 3; i++) {
      h.advance();
      await page.waitForTimeout(600);
      await h.step(`raw frames ${i + 1}`, false);
    }

    // eslint-disable-next-line no-console
    console.log(`\n[popping] idle dead-reckoned\n${h.table()}\n[popping] ${h.summary()}\n`);

    const backwards = h.steps.reduce((a, s) => a + s.backwards.length, 0);
    const worstBackDeg = Math.max(0, ...h.steps.flatMap((s) => s.backwards.map((b) => b.backDeg)));
    expect(backwards, `${backwards} plane(s) moved backwards while the view was idle (worst ${worstBackDeg.toFixed(4)} deg)`).toBe(0);
    expect(h.pageErrors, "page errors").toEqual([]);
  });

  // #151: a settled view shows its full plane set in one update. The server
  // learns a newly watched area over time (`ramp`): /live answers with part of
  // it and the rest follows, report by report, as WebSocket frames. Drawing each
  // frame's new aircraft the moment it lands made the set grow plane by plane
  // for seconds with nobody touching the map (14 -> 22 at z8, 39 -> 54 back on a
  // cached view). The drawn count is sampled every 250 ms of app time after the
  // view settles: it may step up by whole groups of planes at most twice (the snapshot,
  // then one batch of everything that followed) and never down by a group.
  test("a settled view fills in one update, not plane by plane", async ({ page }, testInfo) => {
    test.setTimeout(240_000);
    const h = await startReplay(page, testInfo, { ramp: { startFrac: 0.5, perTick: 0.2 } });
    await boot(page);
    // The app's clock only moves when the test moves it (no real sleeps): each
    // sample is 250 ms of app time, and a tick's frames are pushed before its first.
    const pauseClock = async () => page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1_000);
    const countsAfter = async (rounds: number): Promise<number[]> => {
      const counts: number[] = [];
      for (let r = 0; r < rounds; r++) {
        h.advance(); // one recorded tick: its frames are pushed
        for (let i = 0; i < 8; i++) {
          await page.clock.runFor(250);
          counts.push((await h.drawn()).length);
        }
      }
      return counts;
    };
    /** Lets the view's /live response land and be drawn (the first sample is its set, not a fill step). */
    const landed = async (min: number) =>
      expect
        .poll(async () => { await page.clock.runFor(250); return (await h.drawn()).length; }, { timeout: 20_000, intervals: [50] })
        .toBeGreaterThanOrEqual(min);
    // A fill is a step of several planes at once; a plane or two drifting in or
    // out of the declutter between ticks is the popping budget's business above.
    const FILL_STEP = 3;
    const updates = (c: number[]): number => c.filter((n, i) => i > 0 && n - c[i - 1] >= FILL_STEP).length;
    const drops = (c: number[]): number => c.filter((n, i) => i > 0 && c[i - 1] - n >= FILL_STEP).length;

    await jumpTo(page, CENTRE.lat, CENTRE.lon, 7);
    await pauseClock();
    await page.clock.runFor(1500);
    h.restartRamp();
    await jumpTo(page, CENTRE.lat, CENTRE.lon, 8); // 7 -> 8: the individual-marker view of an area not watched yet
    await landed(30);
    const zoomIn = await countsAfter(9);

    await drag(page, -500, 0); // away, so the first view is only in the cache
    await page.clock.runFor(1500);
    h.restartRamp();
    await drag(page, 500, 0); // and back: the cached set first, then the refresh
    await landed(30);
    const back = await countsAfter(9);

    // eslint-disable-next-line no-console
    console.log(`\n[popping] settled fill\n  zoom in : ${zoomIn.join(",")}\n  back    : ${back.join(",")}\n  updates ${updates(zoomIn)} / ${updates(back)}, drops ${drops(zoomIn)} / ${drops(back)}\n`);
    expect(updates(zoomIn), `zoom in: the set changed in ${updates(zoomIn)} updates after settling`).toBeLessThanOrEqual(2);
    expect(updates(back), `back: the set changed in ${updates(back)} updates after settling`).toBeLessThanOrEqual(2);
    expect(drops(zoomIn) + drops(back), "the set shrank while the view was still").toBe(0);
    expect(h.pageErrors, "page errors").toEqual([]);
  });

  // The opening view is never held (#151 review). The server knows nothing at
  // first (an empty /live), then everything: the planes the frames bring must
  // be drawn at once, not after the fill window a view change opens.
  test("an empty snapshot at boot does not hold the planes that follow", async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    const h = await startReplay(page, testInfo, { ramp: { startFrac: 0, perTick: 1 } });
    await page.goto("/");
    await expect(page.locator('.map-container[data-ready="true"]')).toBeVisible({ timeout: 60_000 });
    await jumpTo(page, CENTRE.lat, CENTRE.lon, 8); // the individual-marker view, empty for now
    await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1_000);
    await page.clock.runFor(1_000);
    expect((await h.drawn()).length, "nothing is known yet").toBe(0);
    const t0 = await page.evaluate(() => Date.now());
    h.advance(); // the server now knows everything: frames for the whole view
    await expect
      .poll(async () => { await page.clock.runFor(250); return (await h.drawn()).length; }, { timeout: 20_000, intervals: [50], message: "the frames' planes are drawn" })
      .toBeGreaterThanOrEqual(30);
    // ... within a couple of seconds of app time, far under the hold's 4 to 12 s.
    expect((await page.evaluate(() => Date.now())) - t0, "drawn without waiting out a hold").toBeLessThan(3_000);
    expect(h.pageErrors, "page errors").toEqual([]);
  });

  // A *full* opening snapshot (#151 review, the other half of the test above):
  // boot where the first /live snapshot already carries a real set — at least the
  // hold's own minimum of 5 planes — and the rest of the area still follows as
  // WebSocket frames. The hold reads `liveSnapshotSeen` and `viewChanged`, and at
  // boot neither is a view change that landed a set, so it must not arm: the
  // frames' planes are drawn at once, not held for the fill window (4 to 12 s).
  test("a boot snapshot with five or more planes draws the frames that follow at once", async ({ page }, testInfo) => {
    test.setTimeout(240_000);
    // The server knows a real slice of the area from the first snapshot (>= 5),
    // then the rest of the fleet as the ticks go on.
    const h = await startReplay(page, testInfo, { ramp: { startFrac: 0.1, perTick: 1 } });
    await page.goto("/");
    await waitForMapReady(page, 60_000);
    await jumpTo(page, CENTRE.lat, CENTRE.lon, 8); // the individual-marker view, partly known for now
    // Headroom on the pause target: the page clock keeps advancing until the
    // pause lands, and under contention it can pass a 1 s target between the
    // read and the pause ("Cannot fast-forward to the past"). 5 s is still
    // under the first periodic timer (the 10 s overview refresh), so the jump
    // fires nothing but the 250 ms viewport debounce.
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 5_000));
    await page.clock.runFor(1_000);
    await expect
      .poll(async () => { await page.clock.runFor(250); return (await h.drawn()).length; }, { timeout: 20_000, intervals: [50], message: "the opening snapshot draws its planes" })
      .toBeGreaterThanOrEqual(5);
    const snapshotDrawn = (await h.drawn()).length;
    const t0 = await page.evaluate(() => Date.now());
    h.advance(); // the server now knows the whole view: frames for the rest of it
    await expect
      .poll(async () => { await page.clock.runFor(250); return (await h.drawn()).length; }, { timeout: 20_000, intervals: [50], message: "the frames' planes are drawn" })
      .toBeGreaterThanOrEqual(30);
    const filled = (await h.drawn()).length;
    const waitedMs = (await page.evaluate(() => Date.now())) - t0;
    // The frames really did add planes the snapshot did not carry: without this
    // the timing check below could pass on a set the snapshot already drew whole.
    expect(filled, "the frames added the planes the snapshot did not have").toBeGreaterThan(snapshotDrawn);
    // eslint-disable-next-line no-console
    console.log(`\n[popping] boot snapshot\n  snapshot drew ${snapshotDrawn}, frames drew the rest to ${filled} after ${waitedMs} ms app time\n`);
    // ... within a couple of seconds of app time, far under the hold's 4 to 12 s.
    expect(waitedMs, "drawn without waiting out a hold").toBeLessThan(3_000);
    expect(h.pageErrors, "page errors").toEqual([]);
  });
});
