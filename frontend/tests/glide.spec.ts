import { expect, test } from "@playwright/test";
import { GLIDE_MAX_MS, glidePending, glidePoint, glidedPoint, recordFix, type Track } from "../src/map/glide";
import { freezeClock, mockFlightApi, planeLayerPositions, setMapView, waitForMapReady } from "./helpers";

// Client-side glide between position reports (section9-hq#250).
//
// The live feed pushes one report per aircraft every few seconds; between two
// reports a drawn marker used to sit still and then jump when the next one
// landed. With the glide on (?glide=1 — it is off by default) it moves along
// the track its last two reports imply, at the speed they imply, and stops a
// few seconds past the newest report instead of guessing further.
//
// The app spec freezes the page clock, so the reports' `observedAt` stamps and
// the glide's own elapsed time are exactly what `page.clock.runFor` advances
// them by, and it reads the drawn coordinates out of the plane source (where
// the glide puts them, so it needs no rendered frame).

const ICAO = "4ca7b3";
const FIX1 = { lat: 51.5, lon: -0.5 };
// One ~20 s report interval of flight due east at ~76 m/s (plausible for a jet).
const REPORT_GAP_MS = 20_000;
const FIX2 = { lat: 51.5, lon: -0.4778 };

test("a plane glides between fixes and stops at the clamp", async ({ page }) => {
  test.setTimeout(120_000);
  await freezeClock(page);
  await mockFlightApi(page);
  let baseMs = 0; // the frozen clock's own instant, read once the page has loaded
  let push: ((m: unknown) => void) | null = null;
  // The live feed, late enough to win over mockFlightApi's own accept-only route.
  await page.routeWebSocket("**/ws/live", (ws) => {
    push = (m) => ws.send(JSON.stringify(m));
  });
  const marker = (at: string, fix: { lat: number; lon: number }) => ({
    id: 1,
    icao24: ICAO,
    callsign: "GLD001",
    observedAt: at,
    latitude: fix.lat,
    longitude: fix.lon,
    headingDeg: 90,
    onGround: false,
  });
  // The first report: the zoomed-in viewport's own /live snapshot.
  await page.route(/\/api\/flights\/live\?/, (route) => route.fulfill({ json: [marker(new Date(baseMs).toISOString(), FIX1)] }));

  await page.goto("/?glide=1");
  baseMs = await page.evaluate(() => Date.now());
  await waitForMapReady(page, 60_000);
  await setMapView(page, FIX1.lat, FIX1.lon, 11);
  await page.clock.runFor(300); // past the viewport debounce (VIEWPORT_DEBOUNCE_MS)

  const plane = async () => (await planeLayerPositions(page))[0];
  await expect.poll(async () => (await planeLayerPositions(page)).length, { timeout: 15_000 }).toBe(1);
  expect((await plane()).lon).toBeCloseTo(FIX1.lon, 6);

  // The next report, one interval on, pushed by the feed (the real path).
  await expect.poll(() => push !== null, { timeout: 10_000 }).toBe(true);
  await page.clock.runFor(REPORT_GAP_MS);
  const stamped = await page.evaluate(() => Date.now());
  push!({ ...marker(new Date(stamped).toISOString(), FIX2), altitudeM: 10_000, velocityMs: 76, verticalRateMs: 0, agentSource: "spec" });
  await page.clock.runFor(250); // WS_FLUSH_MS: frames are applied in one batch

  // The frame is applied one flush interval (WS_FLUSH_MS) after it is pushed, so
  // the marker is already that far along the new track - past the fix, and only
  // by the flush's own fraction of the report interval.
  const afterFix = (await plane()).lon;
  expect(afterFix, "moved past the new fix").toBeGreaterThan(FIX2.lon);
  expect(afterFix - FIX2.lon, "only the flush's own slice of the report step").toBeLessThan(0.01);
  expect((await plane()).lat).toBeCloseTo(FIX2.lat, 6);

  // Between fixes the marker advances along the track, never backwards.
  const steps: number[] = [afterFix];
  for (const ms of [1_000, 1_000]) {
    await page.clock.runFor(ms);
    steps.push((await plane()).lon);
  }
  expect(steps[1], "advanced past the fix").toBeGreaterThan(steps[0]);
  expect(steps[2], "still advancing a couple of seconds in").toBeGreaterThan(steps[1]);
  expect((await plane()).lat).toBeCloseTo(FIX2.lat, 6); // straight east: no latitude drift

  // The clamp: a few seconds of travel past the newest fix, then nothing more.
  await page.clock.runFor(6_000); // past GLIDE_MAX_MS
  const clamped = (await plane()).lon;
  expect(clamped).toBeGreaterThan(steps[2]);
  expect(clamped - FIX2.lon, "clamped to a few seconds of travel, not the whole report step").toBeLessThan(0.01);

  await page.clock.runFor(10_000);
  expect((await plane()).lon, "stops at the clamp").toBeCloseTo(clamped, 9);
});

// The same rules as pure functions: the clamp past the newest fix, the floor the
// glide never goes behind, and the reports it refuses to glide along.
test("glide math: clamps past the newest fix and never moves a plane backwards", () => {
  const PREV = { lat: 51.5, lon: -0.5, atMs: 1_000_000 };
  const CUR = { lat: 51.5, lon: -0.4778, atMs: 1_020_000 };
  const at = (ms: number, lat: number, lon: number) => ({ observedAt: new Date(ms).toISOString(), latitude: lat, longitude: lon });

  const one = recordFix(undefined, at(CUR.atMs, CUR.lat, CUR.lon));
  const track: Track = recordFix(recordFix(undefined, at(PREV.atMs, PREV.lat, PREV.lon)), at(CUR.atMs, CUR.lat, CUR.lon));
  expect(track.prev).toEqual(PREV);
  expect(track.cur).toEqual(CUR);
  // Recording the same report again, or an older one, leaves the track alone.
  expect(recordFix(track, at(CUR.atMs, CUR.lat, CUR.lon))).toBe(track);
  expect(recordFix(track, at(PREV.atMs, PREV.lat, PREV.lon))).toBe(track);

  // Nothing to glide: no time past the newest fix, and a single fix has no track.
  expect(glidePoint(track, CUR.atMs)).toBeNull();
  expect(glidePoint(one, CUR.atMs + 1_000)).toBeNull();
  expect(glidePending(one, CUR.atMs + 1_000)).toBe(false);

  // Between the fix and the clamp: always ahead of the newest fix, further along
  // with more time, and never past the clamped point.
  const atClamp = glidePoint(track, CUR.atMs + GLIDE_MAX_MS)!;
  const pastClamp = glidePoint(track, CUR.atMs + GLIDE_MAX_MS * 10)!;
  const half = glidePoint(track, CUR.atMs + GLIDE_MAX_MS / 2)!;
  expect(atClamp.lon).toBeGreaterThan(CUR.lon);
  expect(half.lon).toBeGreaterThan(CUR.lon);
  expect(half.lon).toBeLessThan(atClamp.lon);
  expect(pastClamp.lon).toBeCloseTo(atClamp.lon, 9);
  expect(glidePending(track, CUR.atMs + GLIDE_MAX_MS)).toBe(false);

  // A report behind the point already drawn holds the marker there (no backwards
  // move); one ahead of it moves the marker at once.
  const floor = { lat: CUR.lat, lon: CUR.lon + 0.005 };
  expect(glidedPoint({ lat: CUR.lat, lon: CUR.lon - 0.001 }, track, CUR.atMs + 100, floor)).toEqual(floor);
  const ahead = { lat: CUR.lat, lon: CUR.lon + 0.01 };
  expect(glidedPoint(ahead, track, CUR.atMs + 100, floor)).toEqual(ahead);

  // A parked aircraft (implied speed under the floor) is never glided.
  const parked = recordFix(recordFix(undefined, at(PREV.atMs, 51.5, -0.5)), at(PREV.atMs + 60_000, 51.5, -0.50001));
  expect(glidePoint(parked, PREV.atMs + 61_000)).toBeNull();

  // Two reports too far apart to be "between fixes" at all: no glide.
  const stale = recordFix(one, at(CUR.atMs + 120_000, CUR.lat, CUR.lon + 0.1));
  expect(glidePoint(stale, CUR.atMs + 121_000)).toBeNull();
});
