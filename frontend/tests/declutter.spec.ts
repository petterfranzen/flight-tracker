import { expect, test, type Page } from "@playwright/test";
import { pickNonOverlapping, type Candidate } from "../src/map/declutter";
import { mockFlightApi, renderedPlanes, setMapView } from "./helpers";

// No clustering: planes are big, and where two would overlap on screen only the
// first discovered one is drawn (map/declutter.ts). Discovery order is the
// order the map first saw them in: the order of the server's list.

const BASE = { lat: 59.65, lon: 17.93 };
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

interface Opts {
  onGround?: boolean;
  ageMinutes?: number;
}
const plane = (icao24: string, callsign: string, lat: number, lon: number, o: Opts = {}) => ({
  icao24,
  callsign,
  observedAt: minutesAgo(o.ageMinutes ?? 1),
  latitude: lat,
  longitude: lon,
  headingDeg: 90,
  onGround: o.onGround ?? false,
});

/** `cols` x rows planes on a lattice 0.35° of longitude by 0.15° of latitude apart: 64 x 54 px at z8, clear of each other. */
function lattice(prefix: string, n: number, cols: number, o: Opts = {}) {
  return Array.from({ length: n }, (_, i) =>
    plane(`${prefix}${i.toString(16).padStart(5, "0")}`, `${prefix.toUpperCase()}${i}`, BASE.lat - 0.7 + Math.floor(i / cols) * 0.15, BASE.lon - 2 + (i % cols) * 0.35, o),
  );
}

async function serve(page: Page, list: ReturnType<typeof plane>[], zoom = 8) {
  await mockFlightApi(page);
  await page.route(/\/api\/flights\/live(\?|$)/, (route) => route.fulfill({ json: list }));
  await page.goto("/");
  await page.waitForSelector(".map-container", { timeout: 10_000 });
  await setMapView(page, BASE.lat, BASE.lon, zoom);
}

const labels = async (page: Page) => (await renderedPlanes(page)).map((p) => p.callsign).sort();
const count = async (page: Page) => (await renderedPlanes(page)).length;

test.describe("hiding overlapping planes", () => {
  test("planes with room around them are all drawn, parked ones included", async ({ page }) => {
    await serve(page, [...lattice("a", 20, 10), ...lattice("g", 30, 10, { onGround: true }).map((p, i) => ({ ...p, latitude: p.latitude + 1.6, longitude: p.longitude + 0.003 * i }))]);
    // 20 airborne on their lattice; the parked block is 1.6° (~580 px) north of it, on the same lattice spacing.
    await expect.poll(() => count(page), { timeout: 10_000 }).toBeGreaterThanOrEqual(20);
    await expect(page.locator(".cluster-icon")).toHaveCount(0);
  });

  test("of two overlapping planes only the first discovered is drawn", async ({ page }) => {
    await serve(
      page,
      [
        plane("aaaaaa", "FIRST", BASE.lat, BASE.lon),
        plane("bbbbbb", "SECOND", BASE.lat + 0.001, BASE.lon + 0.001), // a few px away
        plane("cccccc", "ALONE", BASE.lat, BASE.lon + 0.6), // ~110 px away: room
      ],
      9,
    );
    await expect.poll(() => count(page), { timeout: 10_000 }).toBe(2);
    expect(await labels(page)).toEqual(["ALONE", "FIRST"]);
  });

  test("a hidden plane comes back once zooming in gives it room", async ({ page }) => {
    await serve(
      page,
      [plane("aaaaaa", "FIRST", BASE.lat, BASE.lon), plane("bbbbbb", "SECOND", BASE.lat + 0.01, BASE.lon + 0.01)],
      9,
    );
    await expect.poll(() => count(page), { timeout: 10_000 }).toBe(1);
    await setMapView(page, BASE.lat, BASE.lon, 13);
    await expect.poll(() => count(page), { timeout: 10_000 }).toBe(2);
  });

  test("an active flight beats a parked one that was discovered first", async ({ page }) => {
    await serve(
      page,
      [plane("aaaaaa", "PARKED", BASE.lat, BASE.lon, { onGround: true }), plane("bbbbbb", "FLYING", BASE.lat + 0.001, BASE.lon + 0.001)],
      9,
    );
    await expect.poll(() => count(page), { timeout: 10_000 }).toBe(1);
    expect(await labels(page)).toEqual(["FLYING"]);
  });

  test("a crowded view draws as many as fit and no two overlap", async ({ page }) => {
    // 1,500 aircraft packed into ~2° x 1°: far more than fit on screen at this size.
    const crowd = Array.from({ length: 1500 }, (_, i) =>
      plane(`x${i.toString(16).padStart(5, "0")}`, `X${i}`, BASE.lat - 0.5 + ((i * 7) % 100) * 0.01, BASE.lon - 1 + ((i * 13) % 100) * 0.02),
    );
    await serve(page, crowd, 9);
    await expect.poll(() => count(page), { timeout: 10_000 }).toBeGreaterThan(20);
    const boxes = await renderedPlanes(page);
    expect(boxes.length).toBeLessThan(400); // bounded by the screen, not by the 1,500
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const min = 0.7 * Math.min(boxes[i].size, boxes[j].size) - 1.5; // 1.5px: drawn positions are quantised to the tile grid
        const overlap = Math.abs(boxes[i].x - boxes[j].x) < min && Math.abs(boxes[i].y - boxes[j].y) < min;
        expect(overlap, `planes ${i} and ${j} overlap`).toBe(false);
      }
    }
  });

  test("a few arriving aircraft fade in; a big batch just appears", async ({ page }) => {
    // One fade-in animation per marker is a long task when hundreds arrive at once (see MAX_FADE_IN_BATCH).
    await serve(page, lattice("a", 20, 10));
    await expect.poll(() => count(page), { timeout: 10_000 }).toBe(20);
    expect((await renderedPlanes(page)).filter((p) => p.fadedIn)).toHaveLength(20);
  });

  test("a big batch of arriving aircraft appears without a fade-in", async ({ page }) => {
    await serve(page, lattice("a", 120, 12));
    await expect.poll(() => count(page), { timeout: 10_000 }).toBe(120);
    expect((await renderedPlanes(page)).filter((p) => p.fadedIn)).toHaveLength(0);
  });
});

test.describe("capping how many planes are drawn", () => {
  // Every render projects the candidates and re-sends the drawn set to the map: an uncapped dense
  // view (hundreds of planes; DOM markers when this was written) made zooming laggy, a phone most of all.
  const crowd = (n: number): Candidate[] =>
    Array.from({ length: n }, (_, i) => ({ icao24: `cap${i}`, x: ((i * 7919) % 12_800) / 10, y: ((i * 104_729) % 7_200) / 10, active: true }));

  test("pickNonOverlapping stops at the cap by spacing planes further apart, evenly across the screen", () => {
    const list = crowd(3_000);
    const uncapped = pickNonOverlapping(list, [], 37);
    expect(uncapped.size).toBeGreaterThan(450); // the problem: far more than a zoom step can re-place smoothly
    const capped = pickNonOverlapping(list, [], 37, 300);
    expect(capped.size).toBeLessThanOrEqual(300);
    expect(capped.size).toBeGreaterThan(200); // not thinned much below the cap
    // Evenly spread, not the first 300 in priority order clumped somewhere: every quadrant keeps planes.
    const shown = list.filter((c) => capped.has(c.icao24));
    for (const [left, top] of [[true, true], [true, false], [false, true], [false, false]]) {
      const inQuadrant = shown.filter((c) => (c.x < 640) === left && (c.y < 360) === top).length;
      expect(inQuadrant).toBeGreaterThan(40);
    }
    // And still no overlaps (the spacing only ever grows).
    for (let i = 0; i < shown.length; i++) {
      for (let j = i + 1; j < shown.length; j++) {
        expect(Math.abs(shown[i].x - shown[j].x) >= 0.7 * 37 || Math.abs(shown[i].y - shown[j].y) >= 0.7 * 37).toBe(true);
      }
    }
  });

  test("a cap that is not reached changes nothing", () => {
    const list = crowd(120);
    expect([...pickNonOverlapping(list, [], 37, 300)].sort()).toEqual([...pickNonOverlapping(list, [], 37)].sort());
  });

  test("in the app: a dense view draws at most 300 planes on a laptop, 150 on a phone", async ({ page }) => {
    const dense = Array.from({ length: 3_000 }, (_, i) =>
      plane(`d${i.toString(16).padStart(5, "0")}`, `D${i}`, BASE.lat - 1.2 + (((i * 7919) % 10_000) / 10_000) * 2.4, BASE.lon - 2.5 + (((i * 104_729) % 10_000) / 10_000) * 5),
    );
    await serve(page, dense, 8);
    await expect.poll(() => count(page), { timeout: 10_000 }).toBeGreaterThan(100);
    expect(await count(page)).toBeLessThanOrEqual(300);

    await page.setViewportSize({ width: 400, height: 800 });
    await setMapView(page, BASE.lat, BASE.lon, 8);
    await expect.poll(() => count(page), { timeout: 10_000 }).toBeLessThanOrEqual(150);
    expect(await count(page)).toBeGreaterThan(30);
  });
});

test.describe("big planes", () => {
  test("icons are bigger than the old dart but grow gradually with zoom, and taper to fit stands at an airport", async ({ page }) => {
    await serve(page, [plane("aaaaaa", "SOLO", BASE.lat, BASE.lon)], 8);
    await expect.poll(() => count(page), { timeout: 10_000 }).toBe(1);
    const size = async () => (await renderedPlanes(page))[0].size;
    const sizeAt = async (zoom: number) => {
      await setMapView(page, BASE.lat, BASE.lon, zoom);
      await page.waitForTimeout(300);
      return size();
    };
    const z8 = await sizeAt(8);
    const z10 = await sizeAt(10);
    const z14 = await sizeAt(14);
    const z16 = await sizeAt(16);
    // Intermediate zooms are modest (the old dart was 31 px at z8, 36 at z10), not huge.
    expect(z8).toBeGreaterThanOrEqual(34);
    expect(z8).toBeLessThanOrEqual(40);
    expect(z10).toBeGreaterThan(z8);
    expect(z10).toBeLessThanOrEqual(50);
    expect(z14).toBeGreaterThan(z10);
    expect(z14).toBeLessThanOrEqual(62);
    // At stand zoom (~40 px between gates at z16) they taper so each plane fits its gate.
    expect(z16).toBeLessThan(50);
    expect(z16).toBeGreaterThanOrEqual(36); // still easy to hit
  });

  test("at stand zoom, planes 55 m apart (neighbouring gates) are both drawn", async ({ page }) => {
    // 0.0005 deg of latitude is ~55 m.
    await serve(page, [plane("aaaaaa", "GATE1", BASE.lat, BASE.lon), plane("bbbbbb", "GATE2", BASE.lat + 0.0005, BASE.lon)], 16);
    await expect.poll(() => count(page), { timeout: 10_000 }).toBe(2);
  });

  test("on a phone they are about 20% bigger, for a finger", async ({ page }) => {
    await page.setViewportSize({ width: 400, height: 800 });
    await serve(page, [plane("aaaaaa", "SOLO", BASE.lat, BASE.lon)], 10);
    await expect.poll(() => count(page), { timeout: 10_000 }).toBe(1);
    const z10 = (await renderedPlanes(page))[0].size;
    expect(z10).toBeGreaterThanOrEqual(50); // 43 on a laptop
    expect(z10).toBeLessThanOrEqual(56);
    await setMapView(page, BASE.lat, BASE.lon, 16);
    await page.waitForTimeout(300);
    expect((await renderedPlanes(page))[0].size).toBeLessThan(62);
  });

  test("on a phone, neighbouring gates at stand zoom are both drawn", async ({ page }) => {
    await page.setViewportSize({ width: 400, height: 800 });
    await serve(page, [plane("aaaaaa", "GATE1", BASE.lat, BASE.lon), plane("bbbbbb", "GATE2", BASE.lat + 0.0006, BASE.lon)], 16); // ~67 m
    await expect.poll(() => count(page), { timeout: 10_000 }).toBe(2);
  });
});
