import { expect, test } from "@playwright/test";
import {
  BUDGET,
  CENTRE,
  REC,
  TRAIL_TOL_DEG,
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
    expect(offTrailMaxDeg, `the selected plane left its trail by up to ${offTrailMaxDeg.toFixed(4)} deg`).toBeLessThanOrEqual(TRAIL_TOL_DEG);
    expect(h.pageErrors, "page errors").toEqual([]);
  });

  // The selected plane's estimate (#97, second half of #53's diagnosis).
  // moveSelectedToEstimate puts the marker on the status's dead-reckoned
  // position while keeping the report's observedAt, so a cached /live list of
  // that same report — drawn at once during a pan — compares equal and used to
  // overwrite the estimate: the marker snapped back while the trail stayed
  // ahead. The estimate's as-of (now) is newer than the cached list's, so it
  // survives.
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
});
