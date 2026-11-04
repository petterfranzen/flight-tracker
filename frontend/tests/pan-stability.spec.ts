import { expect, test, type Page } from "@playwright/test";
import { newDeclutterMemory, pickNonOverlapping, type Candidate, type DeclutterMemory } from "../src/map/declutter";
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
