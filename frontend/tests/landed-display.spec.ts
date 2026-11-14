import { expect, test, type Page } from "@playwright/test";
import { hiddenLandedIds, LANDED_HIDE_MS } from "../src/map/landed";
import { mockFlightApi, renderedPlanes, setMapView, waitForMapReady } from "./helpers";
import type { LiveMarker } from "../src/types/flight";

// A landed plane stays in the live set for up to 24 h, and one that left
// radar coverage on the ground stopped reporting where it stopped — at the
// runway end. Past LANDED_HIDE_MS of silence the map leaves it off rather
// than drawing a position that is hours out of date (map/landed.ts). The
// state now comes on every marker of the live snapshot, not just the
// selected plane's status, so the rule applies to all of them — except a
// plane a provider has put at a gate (AT_GATE), which is kept: its gate is
// known and the gate display draws it there.

const NOW = Date.parse("2026-01-01T12:00:00Z");
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();
// The map compares observedAt against the real clock, so its fixtures are
// relative to now, not to the pure tests' fixed NOW.
const sinceNow = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

function marker(icao24: string, o: { minutes: number; onGround?: boolean; state?: LiveMarker["state"] }): LiveMarker {
  return {
    icao24,
    callsign: icao24.toUpperCase(),
    observedAt: minutesAgo(o.minutes),
    latitude: 59.65,
    longitude: 17.93,
    headingDeg: 90,
    onGround: o.onGround,
    state: o.state,
  };
}

const BASE = { lat: 59.65, lon: 17.93 };

test.describe("hiddenLandedIds", () => {
  test("hides a plane gone quiet on the ground past the threshold", () => {
    const hidden = hiddenLandedIds([marker("aaaaaa", { minutes: 45, onGround: true, state: "ON_GROUND" })], NOW);
    expect([...hidden]).toEqual(["aaaaaa"]);
  });

  test("keeps a grounded plane that is still reporting", () => {
    const hidden = hiddenLandedIds([marker("bbbbbb", { minutes: 2, onGround: true, state: "ON_GROUND" })], NOW);
    expect(hidden.size).toBe(0);
  });

  test("hides an inferred landing with a silent last report, even if it was airborne then", () => {
    const hidden = hiddenLandedIds([marker("cccccc", { minutes: 60, onGround: false, state: "LANDED_INFERRED" })], NOW);
    expect([...hidden]).toEqual(["cccccc"]);
  });

  test("keeps a silent airborne plane (COVERAGE_LOST) — where it is is still an open question", () => {
    const hidden = hiddenLandedIds([marker("dddddd", { minutes: 600, onGround: false, state: "COVERAGE_LOST" })], NOW);
    expect(hidden.size).toBe(0);
  });

  test("keeps a plane a provider has put at a gate, however old the last report is", () => {
    // A gate-confirmed plane is drawn at its gate (map/gatePlacement.ts) once selected:
    // there is nothing stale to hide, so it stays on the map.
    const hidden = hiddenLandedIds([marker("gate01", { minutes: 120, onGround: true, state: "AT_GATE" })], NOW);
    expect(hidden.size).toBe(0);
  });

  test("keeps live traffic however old the state list is", () => {
    const hidden = hiddenLandedIds([marker("eeeeee", { minutes: 500, onGround: false, state: "LIVE" })], NOW);
    expect(hidden.size).toBe(0);
  });

  test("falls back to onGround when the payload carries no state", () => {
    const list = [
      marker("fffff1", { minutes: 45, onGround: true }), // grounded, silent: hidden
      marker("fffff2", { minutes: 45, onGround: false }), // airborne, old: kept
      marker("fffff3", { minutes: 1, onGround: true }), // grounded, fresh: kept
    ];
    expect([...hiddenLandedIds(list, NOW)]).toEqual(["fffff1"]);
  });

  test("the threshold is 30 minutes", () => {
    expect(LANDED_HIDE_MS).toBe(30 * 60 * 1000);
    const justUnder = hiddenLandedIds([marker("gggggg", { minutes: 29, onGround: true, state: "ON_GROUND" })], NOW);
    const justOver = hiddenLandedIds([marker("gggggg", { minutes: 31, onGround: true, state: "ON_GROUND" })], NOW);
    expect(justUnder.size).toBe(0);
    expect([...justOver]).toEqual(["gggggg"]);
  });
});

/** A /live snapshot served instead of the shared fixture, at a zoomed-in view over the markers. */
async function serve(page: Page, list: LiveMarker[]): Promise<void> {
  await mockFlightApi(page);
  // Later registration wins over the shared mock's /live.
  await page.route(/\/api\/flights\/live(\?|$)/, (route) => route.fulfill({ json: list }));
  await page.goto("/");
  // 60 s, not the 10 s default: a software-WebGL sandbox boots the map far slower than CI (CLAUDE.md's budget assumes CI's box).
  await waitForMapReady(page, 60_000);
  await setMapView(page, BASE.lat, BASE.lon, 12);
}

async function drawnCallsigns(page: Page): Promise<string[]> {
  await expect.poll(async () => (await renderedPlanes(page)).length, { timeout: 30_000 }).toBeGreaterThan(0);
  return (await renderedPlanes(page)).map((p) => p.callsign).sort();
}

test.describe("landed planes on the map", () => {
  test("a plane gone quiet on the ground is not drawn; the ones still reporting are", async ({ page }) => {
    const at = (icao24: string, m: number, dLat: number, onGround: boolean, state: LiveMarker["state"]): LiveMarker => ({
      ...marker(icao24, { minutes: m, onGround, state }),
      observedAt: sinceNow(m),
      latitude: BASE.lat + dLat,
      longitude: BASE.lon,
    });
    await serve(page, [
      at("aaaaaa", 45, 0, true, "ON_GROUND"), // silent on the ground: hidden
      at("bbbbbb", 2, 0.02, true, "ON_GROUND"), // taxiing: drawn
      at("cccccc", 1, 0.04, false, "LIVE"), // airborne: drawn
      at("dddddd", 45, 0.06, true, "AT_GATE"), // at its gate, silent: drawn (at the gate once selected)
    ]);

    await expect.poll(() => drawnCallsigns(page), { timeout: 10_000 }).toEqual(["BBBBBB", "CCCCCC", "DDDDDD"]);
  });
});
