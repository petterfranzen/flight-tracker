import { expect, test, type Page } from "@playwright/test";
import { newDeclutterMemory, pickNonOverlapping, spacingKey, spacingLevel, type Candidate, type DeclutterMemory } from "../src/map/declutter";
import { planeBoxSize } from "../src/map/planes";
import { declutterSpacing, mockFlightApi, renderedPlanes, setMapView, trackRequests, waitForMapReady } from "./helpers";

// Panning at a fixed zoom must not make planes pop in and out all over the
// screen (Petter's screencast, 30 Oct). #138 fixed the case where planes were
// re-picked from scratch on every pan. One case was left: once the pan pushed
// the drawn count over the cap, `pickNonOverlapping` multiplied the spacing for
// every plane on screen, so planes that were already drawn got dropped all over
// the map. The spacing now belongs to the zoom level (and the cap); a pan that
// passes the cap widens the spacing for the newcomers only, and the planes
// drawn last time keep their place.

const ZOOM = 8;
const LAT = 59.4;
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

/** Deterministic, uneven traffic (denser to the east) over a band much wider than one view, so the count on screen changes as it pans. */
function traffic(n: number) {
  let seed = 7;
  const rnd = () => ((seed = (seed * 16_807) % 2_147_483_647) - 1) / 2_147_483_646;
  return Array.from({ length: n }, (_, i) => ({
    icao24: `p${i.toString(16).padStart(5, "0")}`,
    callsign: `P${i}`,
    observedAt: minutesAgo(1),
    latitude: LAT - 1.8 + rnd() * 3.6,
    longitude: 6 + Math.sqrt(rnd()) * 26, // 6°E..32°E, density rising eastwards
    headingDeg: 90,
    onGround: false,
  }));
}

/** /live answers for the requested bbox only, as the server does. */
async function serveByBbox(page: Page, list: ReturnType<typeof traffic>) {
  await mockFlightApi(page, { overviewPlanes: list });
  await page.route(/\/api\/flights\/live(\?|$)/, (route) => {
    const q = new URL(route.request().url()).searchParams;
    const [latMin, latMax, lonMin, lonMax] = ["latMin", "latMax", "lonMin", "lonMax"].map((k) => Number(q.get(k)));
    return route.fulfill({ json: list.filter((p) => p.latitude >= latMin && p.latitude <= latMax && p.longitude >= lonMin && p.longitude <= lonMax) });
  });
}

interface View {
  drawn: Map<string, { x: number; y: number }>;
  width: number;
  height: number;
}

/** What is drawn once the view's /live request has landed and the drawn set stopped changing. */
async function settledView(page: Page, live: ReturnType<typeof trackRequests>): Promise<View> {
  await live.settled(400);
  let prev = "";
  let view: View | null = null;
  await expect
    .poll(
      async () => {
        const planes = await renderedPlanes(page);
        const key = planes.map((p) => p.icao24).sort().join();
        const same = key === prev;
        prev = key;
        const box = (await page.locator(".map-container").boundingBox())!;
        view = { drawn: new Map(planes.map((p) => [p.icao24, { x: p.x - box.x, y: p.y - box.y }])), width: box.width, height: box.height };
        return same && planes.length > 0;
      },
      { timeout: 10_000, intervals: [250], message: "drawn set settled" },
    )
    .toBe(true);
  return view!;
}

const inside = (x: number, y: number, v: View, inset: number) => x > inset && x < v.width - inset && y > inset && y < v.height - inset;

test.describe("panning at a fixed zoom", () => {
  test("a plane drawn well inside two consecutive views is drawn in both", async ({ page }) => {
    // Ten views of a few thousand planes, each waited out: a slow, shared machine needs more than the default budget.
    test.setTimeout(240_000);
    await serveByBbox(page, traffic(4_000));
    const live = trackRequests(page, /\/api\/flights\/live\?/);
    await page.goto("/");
    await waitForMapReady(page);

    // West to east and back, ~1.2° (~220 px) a step at z8, into ever denser traffic and out again.
    const lons = [12, 13.2, 14.4, 15.6, 16.8, 18, 19.2, 18, 16.8, 15.6];
    const views: View[] = [];
    for (const lon of lons) {
      await setMapView(page, LAT, lon, ZOOM);
      views.push(await settledView(page, live));
    }
    expect(Math.max(...views.map((v) => v.drawn.size))).toBeGreaterThan(150); // dense enough that the cap is in play

    const dLonPx = (256 * 2 ** ZOOM) / 360;
    const inset = 60; // a plane near an edge can be truly overlapped by one just arriving in the margin
    const popped: string[] = [];
    for (let i = 1; i < views.length; i++) {
      const [a, b] = [views[i - 1], views[i]];
      const shift = (lons[i] - lons[i - 1]) * dLonPx; // where a's points land in b
      for (const [id, pa] of a.drawn) {
        const xb = pa.x - shift;
        if (!inside(pa.x, pa.y, a, inset) || !inside(xb, pa.y, b, inset)) continue;
        if (!b.drawn.has(id)) popped.push(`${id} out at step ${i}`);
      }
      for (const [id, pb] of b.drawn) {
        const xa = pb.x + shift;
        if (!inside(pb.x, pb.y, b, inset) || !inside(xa, pb.y, a, inset)) continue;
        if (!a.drawn.has(id)) popped.push(`${id} in at step ${i}`);
      }
    }
    expect(popped).toEqual([]);
  });
});

test.describe("pickNonOverlapping with memory", () => {
  // A grid of active candidates, 20 px apart: more than the cap at a 26 px box.
  const grid = (cols: number, rows: number, x0 = 0): Candidate[] =>
    Array.from({ length: cols * rows }, (_, i) => ({ icao24: `m${x0}_${i}`, x: x0 + (i % cols) * 20, y: Math.floor(i / cols) * 20, active: true }));

  test("more candidates at the edge don't change what is kept in the middle", () => {
    const memory: DeclutterMemory = newDeclutterMemory();
    const first = pickNonOverlapping(grid(40, 30), [], 30, 150, memory, "z8");
    // Pan: the same planes plus a wide new strip on the right, which pushes the count further over the cap.
    const second = pickNonOverlapping([...grid(40, 30), ...grid(20, 30, 800)], [], 30, 150, memory, "z8");
    const kept = [...first].filter((id) => second.has(id));
    expect(kept.length).toBeGreaterThan(first.size * 0.9);
    expect(second.size).toBeLessThanOrEqual(150);
  });

  test("a cap that grows re-spaces the whole screen, not just the newcomers", () => {
    const memory: DeclutterMemory = newDeclutterMemory();
    const wide = pickNonOverlapping(grid(40, 30), [], 30, 150, memory, "z8:150");
    // Switching to a laptop-sized view (the same zoom, a bigger cap) re-fits the screen.
    const roomy = pickNonOverlapping(grid(40, 30), [], 30, 300, memory, "z8:300");
    expect(roomy.size).toBeGreaterThan(wide.size);
    expect(roomy.size).toBeLessThanOrEqual(300);
  });

  test("a higher-priority plane that truly overlaps a drawn one still wins", () => {
    const memory: DeclutterMemory = newDeclutterMemory();
    pickNonOverlapping([{ icao24: "late", x: 100, y: 100, active: true }], [], 30, 150, memory, "z8");
    const shown = pickNonOverlapping(
      [
        { icao24: "late", x: 100, y: 100, active: false }, // parked now
        { icao24: "busy", x: 105, y: 100, active: true },
      ],
      [],
      30,
      150,
      memory,
      "z8",
    );
    expect([...shown]).toEqual(["busy"]);
  });
});


// Follow-ups from the QA of #141 (section9-hq #66). The spacing memory added by
// #141 is keyed on `<rounded zoom>:<cap>` and never relaxes; both are fixed here,
// one spec each (the relaxation has two halves).
//
// Every spec reads the app's own call site as well as the helper:
// `declutterSpacing()` is the box, key and widening that `renderAircraftLayer`
// last handed `pickNonOverlapping`, after a real pan or zoom. Reverting the call
// site back to a fractional box or a key without the source or the whole level
// fails all of them — the earlier versions re-derived the call site's inputs
// from the helper and stayed green through exactly that regression (QA of #148).

/** A grid of active candidates 20 px apart: far more than the cap at a 30 px box. */
const gridAt = (cols: number, rows: number, x0 = 0): Candidate[] =>
  Array.from({ length: cols * rows }, (_, i) => ({ icao24: `g${x0}_${i}`, x: x0 + (i % cols) * 20, y: Math.floor(i / cols) * 20, active: true }));

/** The box, key and widening the app's last render used (main.ts renderAircraftLayer). */
async function callSite(page: Page) {
  const s = await declutterSpacing(page);
  if (!s) throw new Error("renderAircraftLayer has not run yet");
  return s;
}

/** Wait until the app keys its spacing under `prefix`, then return what it used. */
async function callSiteForKey(page: Page, prefix: string, timeout = 30_000) {
  await expect
    .poll(async () => ((await declutterSpacing(page))?.key ?? "").startsWith(prefix), {
      timeout,
      message: `the app's spacing key starts with ${prefix}`,
    })
    .toBe(true);
  return callSite(page);
}

/** planeBoxSize reads window.matchMedia for the phone factor; these helper checks run in node. */
function desktopViewport() {
  (globalThis as { window?: unknown }).window = { matchMedia: () => ({ matches: false }) };
}

/**
 * Dense over (lat 59.4, lon 16) on a lattice wider than a z12 viewport and
 * coarser than the icon box, then a handful at lon 21: one pan at one whole
 * level goes from well over the marker cap to a nearly empty view.
 */
function denseThenSparse() {
  const cols = 60;
  const rows = 40;
  const dense = Array.from({ length: cols * rows }, (_, i) => ({
    icao24: `d${i.toString(16).padStart(5, "0")}`,
    callsign: `D${i}`,
    observedAt: minutesAgo(1),
    latitude: 59.25 + Math.floor(i / cols) * 0.005,
    longitude: 15.7 + (i % cols) * 0.006,
    headingDeg: 90,
    onGround: false,
  }));
  const sparse = Array.from({ length: 20 }, (_, i) => ({
    icao24: `s${i}`,
    callsign: `S${i}`,
    observedAt: minutesAgo(1),
    latitude: 59.3 + (i % 5) * 0.05,
    longitude: 20.9 + Math.floor(i / 5) * 0.05,
    headingDeg: 90,
    onGround: false,
  }));
  return [...dense, ...sparse];
}

test.describe("#66 (1) the spacing key follows the whole zoom level", () => {
  test("a pinch inside one level leaves the app's box and key unchanged", async ({ page }) => {
    test.setTimeout(240_000);
    await serveByBbox(page, traffic(4_000));
    await page.goto("/");
    await waitForMapReady(page, 60_000);

    // Two fractional zooms in level 8, then the level's own whole zoom: the app
    // must measure all three with the same whole-level box, and key the first
    // two identically. A fractional box changes at each and fails here.
    await setMapView(page, LAT, 16, 7.6);
    const a = await callSiteForKey(page, "overview:8:");
    await setMapView(page, LAT, 16, 7.9);
    const b = await callSiteForKey(page, "overview:8:");
    await setMapView(page, LAT, 16, 8.0);
    const whole = await callSiteForKey(page, "live:8:");

    expect(a.box).toBe(whole.box); // planeBoxSize(8), whatever a pinch does inside 8
    expect(b.box).toBe(whole.box);
    expect(b.key).toBe(a.key); // one level, one cap, one source: one entry

    // Through the real path: the pinch drew planes, on both sides of it.
    await expect.poll(async () => (await renderedPlanes(page)).length, { timeout: 10_000, message: "planes drawn after a real pinch" }).toBeGreaterThan(0);

    // Given the box and key the app itself uses, the helper re-spaces nothing
    // between the two fractional zooms either.
    const memory = newDeclutterMemory();
    const before = pickNonOverlapping(gridAt(40, 30), [], a.box, Number(a.key.split(":").pop()), memory, a.key);
    const after = pickNonOverlapping(gridAt(40, 30), [], b.box, Number(b.key.split(":").pop()), memory, b.key);
    expect([...after].sort()).toEqual([...before].sort());

    // And the helper's own rule: the box moves fractionally, the whole level does not.
    desktopViewport();
    expect(planeBoxSize(7.6)).not.toBe(planeBoxSize(7.9));
    expect(planeBoxSize(spacingLevel(7.6))).toBe(planeBoxSize(spacingLevel(7.9)));
    expect(spacingKey("live", 7.6, 150)).toBe(spacingKey("live", 7.9, 150));
  });
});

test.describe("#66 (2) a widened spacing relaxes again", () => {
  const KEY = spacingKey("overview", 7.6, 150);

  test("the app relaxes it once most of the drawn planes have left, without dropping one", async ({ page }) => {
    test.setTimeout(240_000);
    await serveByBbox(page, denseThenSparse());
    await page.goto("/");
    await waitForMapReady(page, 60_000);

    await setMapView(page, LAT, 16, 12.4);
    const dense = await callSiteForKey(page, "live:12:");
    // The call site this spec guards: whole-level box, source-qualified key.
    expect(dense.key).toMatch(/^live:12:\d+$/);
    await expect.poll(async () => (await callSite(page)).spacing, { timeout: 30_000, message: "the dense view widened the spacing" }).toBeGreaterThan(1);
    const wide = (await callSite(page)).spacing;
    expect(wide).toBeGreaterThan(1);

    // A pan off the block at the same level: almost none of the drawn planes
    // remain, so the widening was for a density that is gone and relaxes.
    await setMapView(page, LAT, 21, 12.4);
    await expect
      .poll(async () => (await callSite(page)).spacing, { timeout: 30_000, message: "the sparse view relaxed the spacing" })
      .toBe(1);
    // It kept drawing through the pan, and what it draws there is real.
    await expect.poll(async () => (await renderedPlanes(page)).length, { timeout: 10_000, message: "planes drawn on the sparse view" }).toBeGreaterThan(0);

    // The helper's own half, with its own numbers: relaxation drops nothing
    // already drawn, and the room it held open fills in.
    const memory = newDeclutterMemory();
    const grid = gridAt(60, 40);
    const first = pickNonOverlapping(grid, [], 30, 150, memory, KEY);
    expect(first.size).toBeGreaterThan(50);
    expect(memory.spacing).toBeGreaterThan(1); // the cap widened it
    const survivors = grid.filter((c) => first.has(c.icao24)).slice(0, 5);
    const after = pickNonOverlapping(
      [...survivors, { icao24: "new1", x: 4_000, y: 0, active: true }, { icao24: "new2", x: 4_200, y: 0, active: true }],
      [],
      30,
      150,
      memory,
      KEY,
    );
    expect(memory.spacing).toBe(1); // back to the zoom's own spacing
    for (const c of survivors) expect(after.has(c.icao24), `${c.icao24} was on screen and is still drawn`).toBe(true);
    expect(after.has("new1")).toBe(true);
    expect(after.has("new2")).toBe(true);
  });

  test("the app keeps it while most of the drawn planes are still on screen", async ({ page }) => {
    test.setTimeout(240_000);
    await serveByBbox(page, denseThenSparse());
    await page.goto("/");
    await waitForMapReady(page, 60_000);

    await setMapView(page, LAT, 16, 12.4);
    const dense = await callSiteForKey(page, "live:12:");
    await expect.poll(async () => (await callSite(page)).spacing, { timeout: 30_000, message: "the dense view widened the spacing" }).toBeGreaterThan(1);
    const wide = (await callSite(page)).spacing;

    // Same view, one fraction of a whole level over: nearly every drawn plane
    // is still there, so the widening is still doing its job and must not
    // relax under it.
    await setMapView(page, LAT, 16, 12.45);
    const nudged = await callSiteForKey(page, "live:12:");
    expect(nudged.key).toBe(dense.key); // still the same whole level
    expect(nudged.box).toBe(dense.box);
    await expect.poll(async () => (await callSite(page)).spacing, { timeout: 15_000, message: "the widening is kept on the same view" }).toBe(wide);
    expect(wide).toBeGreaterThan(1);

    // The helper's own half, with its own numbers.
    const memory = newDeclutterMemory();
    const grid = gridAt(60, 40);
    const first = pickNonOverlapping(grid, [], 30, 150, memory, KEY);
    const helperWide = memory.spacing;
    expect(helperWide).toBeGreaterThan(1);
    const again = pickNonOverlapping(grid.map((c) => ({ ...c })), [], 30, 150, memory, KEY);
    expect(memory.spacing).toBe(helperWide);
    expect([...again].filter((id) => first.has(id)).length).toBeGreaterThan(first.size * 0.9);
  });
});

test.describe("#66 (3) the source is part of the spacing key", () => {
  test("the app does not hand the overview band's spacing to the live source", async ({ page }) => {
    test.setTimeout(240_000);
    await serveByBbox(page, traffic(4_000));
    await page.goto("/");
    await waitForMapReady(page, 60_000);

    // 7.9 rounds to level 8 but still draws the overview; 8.1 is the live
    // source at the same level. The key must differ so the switch re-works the
    // spacing instead of inheriting the band's.
    await setMapView(page, LAT, 16, 7.9);
    const band = await callSiteForKey(page, "overview:8:");
    await setMapView(page, LAT, 16, 8.1);
    const live = await callSiteForKey(page, "live:8:");

    expect(band.key).not.toBe(live.key);
    expect(band.box).toBe(live.box); // one level, one box; only the source changed
    await expect.poll(async () => (await renderedPlanes(page)).length, { timeout: 10_000, message: "planes drawn after the source switch" }).toBeGreaterThan(0);

    // Given those two keys, the switch re-works the spacing: the live frame all
    // fits at the level's own spacing.
    const memory = newDeclutterMemory();
    const picked = pickNonOverlapping(gridAt(60, 40), [], 30, 300, memory, band.key);
    expect(memory.spacing).toBeGreaterThan(1);
    const liveFrame = gridAt(60, 40).filter((c) => picked.has(c.icao24));
    const switched = pickNonOverlapping(liveFrame, [], 30, 300, memory, live.key);
    expect(memory.spacing).toBe(1);
    expect([...switched].sort()).toEqual(liveFrame.map((c) => c.icao24).sort());

    // The helper's own rule: a level-only key is one string for both sources, so
    // the band's widening is kept when the live frame replaces it.
    expect(spacingKey("overview", 7.6, 150)).not.toBe(spacingKey("live", 8.2, 150));
    expect(spacingKey("overview", 7.6, 150)).toBe(spacingKey("overview", 7.9, 150));
    const stale = newDeclutterMemory();
    pickNonOverlapping(gridAt(60, 40), [], 30, 150, stale, "8:150");
    const frame = gridAt(60, 40).filter((c) => stale.drawn.has(c.icao24));
    pickNonOverlapping(frame, [], 30, 150, stale, "8:150");
    expect(stale.spacing).toBeGreaterThan(1); // what the level-only key kept
  });
});
