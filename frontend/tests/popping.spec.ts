import { expect, test } from "@playwright/test";
import {
  BUDGET,
  CENTRE,
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

test.describe.configure({ mode: "serial" });
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

  // eslint-disable-next-line no-console
  console.log(`\n[popping] ${scenario}\n${h.table()}\n[popping] ${scenario}: ${h.summary()}\n`);

  expect(vanished, `${scenario}: ${vanished} planes vanished while the view was still (budget ${BUDGET.vanished})`).toBeLessThanOrEqual(BUDGET.vanished);
  expect(appeared, `${scenario}: ${appeared} planes appeared while the view was still (budget ${BUDGET.appeared})`).toBeLessThanOrEqual(BUDGET.appeared);
  expect(backwards, `${scenario}: ${backwards} planes moved backwards along their track (budget ${BUDGET.backwards})`).toBeLessThanOrEqual(BUDGET.backwards);
  expect(offTrail, `${scenario}: the selected plane left its trail ${offTrail} times (budget ${BUDGET.selectedOffTrail})`).toBeLessThanOrEqual(BUDGET.selectedOffTrail);
  expect(h.pageErrors, `${scenario}: page errors`).toEqual([]);
}

test.describe("popping @scenario", () => {
  test("pan across dense traffic", async ({ page }, testInfo) => {
    test.setTimeout(120_000);
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
    test.setTimeout(120_000);
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
    test.setTimeout(120_000);
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
    test.setTimeout(120_000);
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
});
