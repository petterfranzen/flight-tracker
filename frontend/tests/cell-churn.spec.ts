import { expect, test, type Page } from "@playwright/test";
import { freezeClock, mockFlightApi, overviewLevel, planeLayerIds, setMapView, trackRequests, waitForMapReady } from "./helpers";

// Petter's recording (3 Nov, Stockholm/Arlanda): standing still, single markers
// appear and disappear, and one keeps jumping to a new spot. Zoomed out the
// overview returns one plane per cell, "first discovered wins", recomputed on
// every refresh — so a cell's winner changes as planes move between cells
// (Saito's #1 in section9-hq #49; see map/cellWinners.ts). The cell keeps the
// plane it is drawing while that plane is still live and still in it.

const BASE = { lat: 59.5, lon: 18.0 };
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const plane = (icao24: string, lat: number, lon: number, ageMinutes = 1) => ({
  icao24,
  callsign: icao24.toUpperCase(),
  observedAt: minutesAgo(ageMinutes),
  latitude: lat,
  longitude: lon,
  headingDeg: 90,
  onGround: false,
});

// aaaaaa and bbbbbb fall in the same 0.5° overview cell at zoom 7, 27 px apart
// there — further apart than half an icon, so both are drawn when both come
// back. cccccc is in a cell of its own, on screen and never contested. Moving
// aaaaaa 0.6° east puts it in the next cell (floor(lon / 0.5) 36 -> 37).
const A = plane("aaaaaa", BASE.lat, BASE.lon);
const B = plane("bbbbbb", BASE.lat, BASE.lon + 0.3);
const X = plane("cccccc", BASE.lat + 1, BASE.lon + 1.5);
/** The same cell, but nothing heard from it for 3 h: no longer live traffic. */
const A_STALE = plane("aaaaaa", BASE.lat, BASE.lon, 180);
/** aaaaaa one cell to the east: where it actually is after crossing the boundary. */
const A_EAST = plane("aaaaaa", BASE.lat, BASE.lon + 0.6);

const drawn = async (page: Page): Promise<string[]> => (await planeLayerIds(page)).sort();

/** The planes the mocked zoom-7 overview returns, until the test changes them. */
interface Swap {
  planes: (typeof A)[];
}

/**
 * Opens zoom 7 on the contested cell, with the overview serving `initial` as
 * that cell's winner. Every request for the level returns `swap.planes`, so the
 * test decides what the next refresh asks the client to swap to.
 */
async function openContestedCell(page: Page, initial: (typeof A)[]): Promise<Swap> {
  const swap: Swap = { planes: initial };
  await mockFlightApi(page, { clusters: [] });
  await page.route("**/api/flights/live/overview*", (route) => {
    const level = overviewLevel(page, route.request().url());
    return route.fulfill({ json: { planes: level === 7 ? swap.planes : [], clusters: [] } });
  });
  // The page's clock moves only when the test says, so the app's own 10 s
  // overview refresh is the only thing that asks again, and the frame it has is
  // certainly past the 8 s one counts as fresh.
  await freezeClock(page);
  await page.goto("/");
  await waitForMapReady(page);
  await setMapView(page, BASE.lat, BASE.lon, 7);
  await page.clock.runFor(300); // past the viewport debounce
  await expect.poll(() => drawn(page), { timeout: 15_000 }).toEqual(["aaaaaa", "cccccc"]);
  return swap;
}

test.describe("the overview's per-cell winner", () => {
  test.slow();
  test("a cell keeps the plane it is drawing when the server picks a different one", async ({ page }) => {
    const overview = trackRequests(page, /\/api\/flights\/live\/overview/);
    const swap = await openContestedCell(page, [A, X]);

    // One overview refresh tick. The server's winner for the cell is now
    // bbbbbb; the cell was drawing aaaaaa, still live and still in it.
    const before = overview.sent.length;
    swap.planes = [B, X];
    await page.clock.runFor(10_500);
    await expect.poll(() => overview.sent.length, { timeout: 15_000, message: "the overview was refreshed" }).toBeGreaterThan(before);
    await expect.poll(() => drawn(page), { timeout: 15_000 }).toEqual(["aaaaaa", "cccccc"]);
  });

  test.slow();
  test("the winner is released once it is no longer live", async ({ page }) => {
    const overview = trackRequests(page, /\/api\/flights\/live\/overview/);
    const swap = await openContestedCell(page, [A_STALE, X]);

    // aaaaaa has not reported for 3 h: the cell takes the server's own pick.
    const before = overview.sent.length;
    swap.planes = [B, X];
    await page.clock.runFor(10_500);
    await expect.poll(() => overview.sent.length, { timeout: 15_000, message: "the overview was refreshed" }).toBeGreaterThan(before);
    await expect.poll(() => drawn(page), { timeout: 15_000 }).toEqual(["bbbbbb", "cccccc"]);
  });

  test("a plane that crosses a cell boundary is drawn once, where it is", async ({ page }) => {
    const overview = trackRequests(page, /\/api\/flights\/live\/overview/);
    const swap = await openContestedCell(page, [A, X]);

    // Next refresh: bbbbbb takes the cell aaaaaa has left, and aaaaaa is
    // returned in the cell to its east. Keeping the old copy would draw
    // aaaaaa twice — pinned at 18.0 as well as at 18.6 — and hide bbbbbb.
    const before = overview.sent.length;
    swap.planes = [B, A_EAST, X];
    await page.clock.runFor(10_500);
    await expect.poll(() => overview.sent.length, { timeout: 15_000, message: "the overview was refreshed" }).toBeGreaterThan(before);
    await expect.poll(() => drawn(page), { timeout: 15_000 }).toEqual(["aaaaaa", "bbbbbb", "cccccc"]);
  });
});
