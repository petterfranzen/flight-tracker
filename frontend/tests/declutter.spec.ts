import { expect, test, type Page } from "@playwright/test";
import { mockFlightApi, setMapView } from "./helpers";

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
  await page.waitForSelector(".leaflet-container", { timeout: 10_000 });
  await setMapView(page, BASE.lat, BASE.lon, zoom);
}

const labels = (page: Page) => page.locator(".plane-icon .plane-icon-label").evaluateAll((els) => els.map((e) => e.textContent!).sort());

test.describe("hiding overlapping planes", () => {
  test("planes with room around them are all drawn, parked ones included", async ({ page }) => {
    await serve(page, [...lattice("a", 20, 10), ...lattice("g", 30, 10, { onGround: true }).map((p, i) => ({ ...p, latitude: p.latitude + 1.6, longitude: p.longitude + 0.003 * i }))]);
    // 20 airborne on their lattice; the parked block is 1.6° (~580 px) north of it, on the same lattice spacing.
    await expect.poll(async () => page.locator(".plane-icon").count(), { timeout: 10_000 }).toBeGreaterThanOrEqual(20);
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
    await expect.poll(async () => page.locator(".plane-icon").count(), { timeout: 10_000 }).toBe(2);
    expect(await labels(page)).toEqual(["ALONE", "FIRST"]);
  });

  test("a hidden plane comes back once zooming in gives it room", async ({ page }) => {
    await serve(
      page,
      [plane("aaaaaa", "FIRST", BASE.lat, BASE.lon), plane("bbbbbb", "SECOND", BASE.lat + 0.01, BASE.lon + 0.01)],
      9,
    );
    await expect.poll(async () => page.locator(".plane-icon").count(), { timeout: 10_000 }).toBe(1);
    await setMapView(page, BASE.lat, BASE.lon, 13);
    await expect.poll(async () => page.locator(".plane-icon").count(), { timeout: 10_000 }).toBe(2);
  });

  test("an active flight beats a parked one that was discovered first", async ({ page }) => {
    await serve(
      page,
      [plane("aaaaaa", "PARKED", BASE.lat, BASE.lon, { onGround: true }), plane("bbbbbb", "FLYING", BASE.lat + 0.001, BASE.lon + 0.001)],
      9,
    );
    await expect.poll(async () => page.locator(".plane-icon").count(), { timeout: 10_000 }).toBe(1);
    expect(await labels(page)).toEqual(["FLYING"]);
  });

  test("a crowded view draws as many as fit and no two overlap", async ({ page }) => {
    // 1,500 aircraft packed into ~2° x 1°: far more than fit on screen at this size.
    const crowd = Array.from({ length: 1500 }, (_, i) =>
      plane(`x${i.toString(16).padStart(5, "0")}`, `X${i}`, BASE.lat - 0.5 + ((i * 7) % 100) * 0.01, BASE.lon - 1 + ((i * 13) % 100) * 0.02),
    );
    await serve(page, crowd, 9);
    await expect.poll(async () => page.locator(".plane-icon").count(), { timeout: 10_000 }).toBeGreaterThan(20);
    const boxes = await page.locator(".plane-icon").evaluateAll((els) =>
      els.map((e) => {
        const r = e.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2, size: r.width };
      }),
    );
    expect(boxes.length).toBeLessThan(400); // bounded by the screen, not by the 1,500
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const min = 0.8 * Math.min(boxes[i].size, boxes[j].size) - 1.5; // 1.5px: positions are rounded
        const overlap = Math.abs(boxes[i].x - boxes[j].x) < min && Math.abs(boxes[i].y - boxes[j].y) < min;
        expect(overlap, `planes ${i} and ${j} overlap`).toBe(false);
      }
    }
  });

  test("a few arriving aircraft fade in; a big batch just appears", async ({ page }) => {
    // One fade-in animation per marker is a long task when hundreds arrive at once (see MAX_FADE_IN_BATCH).
    await serve(page, lattice("a", 20, 10));
    await expect.poll(async () => page.locator(".plane-icon").count(), { timeout: 10_000 }).toBe(20);
    await expect(page.locator(".plane-icon--entering")).toHaveCount(20);
  });

  test("a big batch of arriving aircraft appears without a fade-in", async ({ page }) => {
    await serve(page, lattice("a", 120, 12));
    await expect.poll(async () => page.locator(".plane-icon").count(), { timeout: 10_000 }).toBe(120);
    await expect(page.locator(".plane-icon--entering")).toHaveCount(0);
  });
});

test.describe("big planes", () => {
  test("icons are at least twice the old size, and grow a little more zoomed in", async ({ page }) => {
    await serve(page, [plane("aaaaaa", "SOLO", BASE.lat, BASE.lon)], 11);
    await expect.poll(async () => page.locator(".plane-icon").count(), { timeout: 10_000 }).toBe(1);
    const size = async () => (await page.locator(".plane-icon").first().boundingBox())!.width;
    expect(await size()).toBeGreaterThanOrEqual(72); // was 36
    await setMapView(page, BASE.lat, BASE.lon, 14);
    await page.waitForTimeout(300);
    expect(await size()).toBeGreaterThanOrEqual(100); // was 50
  });

  test("on a phone they are bigger still", async ({ page }) => {
    await page.setViewportSize({ width: 400, height: 800 });
    await serve(page, [plane("aaaaaa", "SOLO", BASE.lat, BASE.lon)], 11);
    await expect.poll(async () => page.locator(".plane-icon").count(), { timeout: 10_000 }).toBe(1);
    expect((await page.locator(".plane-icon").first().boundingBox())!.width).toBeGreaterThanOrEqual(92); // was 46
  });
});
