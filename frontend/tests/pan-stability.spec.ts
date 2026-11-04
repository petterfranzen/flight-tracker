import { expect, test, type Page } from "@playwright/test";
import { newDeclutterMemory, pickNonOverlapping, spacingKey, spacingLevel, type Candidate, type DeclutterMemory } from "../src/map/declutter";
import { planeBoxSize } from "../src/map/planes";
import { mockFlightApi, renderedPlanes, setMapView, trackRequests, waitForMapReady } from "./helpers";

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
  await mockFlightApi(page);
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
// one spec each.

/** A grid of active candidates 20 px apart: far more than the cap at a 30 px box. */
const gridAt = (cols: number, rows: number, x0 = 0): Candidate[] =>
  Array.from({ length: cols * rows }, (_, i) => ({ icao24: `g${x0}_${i}`, x: x0 + (i % cols) * 20, y: Math.floor(i / cols) * 20, active: true }));

test.describe("#66 (1) the spacing key follows the whole zoom level", () => {
  test("a pinch inside one level hands the picker the same box and key, so nothing is re-spaced", () => {
    // planeBoxSize reads the viewport (window.matchMedia) for the phone factor;
    // this picker check runs in node, so stand in a desktop viewport.
    (globalThis as { window?: unknown }).window = { matchMedia: () => ({ matches: false }) };
    // The box does move inside a whole level — which is why measuring it at the
    // fractional zoom while keying the memory on the rounded one left the stored
    // widening applied to a box that had changed under it.
    expect(planeBoxSize(7.6)).not.toBe(planeBoxSize(7.9));
    // The call site (main.ts): the box and the key both come from spacingLevel.
    const box = (zoom: number) => planeBoxSize(spacingLevel(zoom));
    const key = (zoom: number) => spacingKey("live", zoom, 150);
    expect(box(7.6)).toBe(box(7.9));
    expect(key(7.6)).toBe(key(7.9));

    const memory = newDeclutterMemory();
    const before = pickNonOverlapping(gridAt(40, 30), [], box(7.6), 150, memory, key(7.6));
    const after = pickNonOverlapping(gridAt(40, 30), [], box(7.9), 150, memory, key(7.9));
    expect([...after].sort()).toEqual([...before].sort());
  });
});

test.describe("#66 (2) a widened spacing relaxes again", () => {
  const KEY = spacingKey("overview", 7.6, 150);

  test("it relaxes once most of the drawn planes have left, without dropping one", () => {
    const memory = newDeclutterMemory();
    const dense = gridAt(60, 40);
    const first = pickNonOverlapping(dense, [], 30, 150, memory, KEY);
    expect(first.size).toBeGreaterThan(50);
    expect(memory.spacing).toBeGreaterThan(1); // the cap widened it

    // Pan out of the dense block: a handful of the planes drawn there are still
    // on screen, and two newcomers arrive in the room the widening held open.
    const survivors = dense.filter((c) => first.has(c.icao24)).slice(0, 5);
    const after = pickNonOverlapping(
      [...survivors, { icao24: "new1", x: 4_000, y: 0, active: true }, { icao24: "new2", x: 4_200, y: 0, active: true }],
      [],
      30,
      150,
      memory,
      KEY,
    );

    expect(memory.spacing).toBe(1); // back to the zoom's own spacing
    // Nothing already drawn drops for it: every survivor is still drawn...
    for (const c of survivors) expect(after.has(c.icao24), `${c.icao24} was on screen and is still drawn`).toBe(true);
    // ...and the room that was held open fills in.
    expect(after.has("new1")).toBe(true);
    expect(after.has("new2")).toBe(true);
  });

  test("it is kept while most of the drawn planes are still on screen", () => {
    const memory = newDeclutterMemory();
    const dense = gridAt(60, 40);
    const first = pickNonOverlapping(dense, [], 30, 150, memory, KEY);
    const wide = memory.spacing;
    expect(wide).toBeGreaterThan(1);

    // The same view: nearly every drawn plane is still there, so the widening is
    // still doing its job and must not be relaxed under it.
    const again = pickNonOverlapping(dense.map((c) => ({ ...c })), [], 30, 150, memory, KEY);
    expect(memory.spacing).toBe(wide);
    expect([...again].filter((id) => first.has(id)).length).toBeGreaterThan(first.size * 0.9);
  });
});

test.describe("#66 (3) the source is part of the spacing key", () => {
  test("the overview band that rounds to level 8 does not hand its spacing to the live source", () => {
    // Below CLUSTER_FETCH_MAX_ZOOM the map draws the overview; the 7.5-8.0 band
    // rounds to level 8, the same level the live source at 8.0 and up uses, so a
    // level-only key is one string for both.
    expect(spacingKey("overview", 7.6, 150)).not.toBe(spacingKey("live", 8.2, 150));
    expect(spacingKey("overview", 7.6, 150)).toBe(spacingKey("overview", 7.9, 150)); // one band, one level

    // With the source in the key, the switch re-works the spacing: level 8's live
    // frame is the band's own planes, which all fit at the level's spacing.
    const memory = newDeclutterMemory();
    const band = pickNonOverlapping(gridAt(60, 40), [], 30, 150, memory, spacingKey("overview", 7.6, 150));
    expect(memory.spacing).toBeGreaterThan(1);
    const live = gridAt(60, 40).filter((c) => band.has(c.icao24));
    const switched = pickNonOverlapping(live, [], 30, 150, memory, spacingKey("live", 8.2, 150));
    expect(memory.spacing).toBe(1);
    expect([...switched].sort()).toEqual(live.map((c) => c.icao24).sort());

    // The key without the source in it (what the call site used to pass) is the
    // same string for both, so the live frame keeps the band's widening instead.
    const stale = newDeclutterMemory();
    pickNonOverlapping(gridAt(60, 40), [], 30, 150, stale, "8:150");
    pickNonOverlapping(live, [], 30, 150, stale, "8:150");
    expect(stale.spacing).toBeGreaterThan(1);
  });
});
