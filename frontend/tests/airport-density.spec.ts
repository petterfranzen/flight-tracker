import { expect, test } from "@playwright/test";
import { clickAirport, mockFlightApi, renderedAirports, setMapView, waitForMapReady, withMap } from "./helpers";

// Two real entries from worldMapData.ts, picked because they sit close
// together in southern Sweden but at opposite ends of Natural Earth's
// significance ranking:
//   ARN (Arlanda)    rank 2 — drawn at every zoom
//   NRK (Norrköping) rank 8 — only once you're zoomed well in
// Kept in sync by hand with MAX_RANK_BY_ZOOM in ui/defaultAirports.ts,
// the same way clustering.spec.ts tracks CLUSTER_FETCH_MAX_ZOOM.
const ALWAYS_SHOWN = "ARN";
const MINOR = "NRK";

const SWEDEN = { lat: 59.0, lon: 17.0 };
const WORLD_ZOOM = 3;
const CLOSE_ZOOM = 9;

/** How many times the airport with this code is drawn in view (the map's airport layer). */
async function drawnCount(page: import("@playwright/test").Page, code: string): Promise<number> {
  return (await renderedAirports(page)).filter((a) => a.code === code).length;
}

const drawn = (page: import("@playwright/test").Page, code: string) => expect.poll(() => drawnCount(page, code), { timeout: 10_000 });

test.describe("airport density by zoom", () => {
  // Only airports in view are drawn: tall enough that ARN and NRK are both on
  // screen around SWEDEN at CLOSE_ZOOM (ARN is ~460 px north of the centre).
  test.use({ viewport: { width: 1280, height: 1000 } });

  test("zoomed out, only the most significant airports are drawn", async ({ page }) => {
    await mockFlightApi(page);
    await page.goto("/");
    await waitForMapReady(page);

    await setMapView(page, SWEDEN.lat, SWEDEN.lon, WORLD_ZOOM);

    await drawn(page, ALWAYS_SHOWN).toBe(1);
    // The whole point of the change: a minor regional airport is noise at
    // world scale, and 878 of them made the map unreadable.
    await drawn(page, MINOR).toBe(0);
  });

  test("zooming in reveals the smaller ones", async ({ page }) => {
    await mockFlightApi(page);
    await page.goto("/");
    await waitForMapReady(page);

    await setMapView(page, SWEDEN.lat, SWEDEN.lon, WORLD_ZOOM);
    await drawn(page, MINOR).toBe(0);

    await setMapView(page, SWEDEN.lat, SWEDEN.lon, CLOSE_ZOOM);

    await drawn(page, MINOR).toBe(1);
    // The major one never disappears on the way in.
    await drawn(page, ALWAYS_SHOWN).toBe(1);
  });

  test("the drawn count grows as you zoom in", async ({ page }) => {
    await mockFlightApi(page);
    await page.goto("/");
    await waitForMapReady(page);

    // Only airports in view are drawn, so the raw count shrinks as the view
    // narrows. Count inside one fixed geographic box instead (the view at the
    // closest zoom), which every zoom's viewport contains.
    await setMapView(page, SWEDEN.lat, SWEDEN.lon, CLOSE_ZOOM);
    const box = await withMap(page, (map) => {
      const b = map.getBounds();
      return { s: b.latMin, n: b.latMax, w: b.lonMin, e: b.lonMax };
    });
    const countInBox = async (page2: import("@playwright/test").Page) =>
      (await renderedAirports(page2)).filter((a) => a.lat >= box.s && a.lat <= box.n && a.lon >= box.w && a.lon <= box.e).length;

    const counts: number[] = [];
    for (const zoom of [WORLD_ZOOM, 5, 7, CLOSE_ZOOM]) {
      await setMapView(page, SWEDEN.lat, SWEDEN.lon, zoom);
      await expect.poll(async () => (await renderedAirports(page)).length, { timeout: 10_000 }).toBeGreaterThan(0);
      // Symbols are placed over several frames: count once two reads agree.
      let count = -1;
      await expect
        .poll(
          async () => {
            const prev = count;
            count = await countInBox(page);
            return count === prev;
          },
          { timeout: 10_000, intervals: [250] },
        )
        .toBe(true);
      counts.push(count);
    }

    // Not asserting exact counts: they move with the Natural Earth source and
    // the rank filter. The behaviour is "never fewer, and more by the end".
    for (let i = 1; i < counts.length; i++) {
      expect(counts[i], `zoom step ${i} should not draw fewer than the previous`).toBeGreaterThanOrEqual(counts[i - 1]);
    }
    expect(counts[counts.length - 1]).toBeGreaterThan(counts[0]);
  });

  test("only airports in view are drawn, and panning brings in the next ones", async ({ page }) => {
    await mockFlightApi(page);
    await page.goto("/");
    await waitForMapReady(page);

    // At the closest zoom every one of the 878 airports passes the rank rule;
    // only those in view may be drawn. (Was 878 DOM markers for a view of ~10.)
    await setMapView(page, SWEDEN.lat, SWEDEN.lon, CLOSE_ZOOM);
    await drawn(page, ALWAYS_SHOWN).toBe(1);
    await expect.poll(async () => (await renderedAirports(page)).length, { timeout: 10_000 }).toBeLessThan(100);
    await drawn(page, "LHR").toBe(0);

    // Panning far away swaps the set.
    await setMapView(page, 51.47, -0.45, CLOSE_ZOOM);
    await drawn(page, "LHR").toBe(1);
    await drawn(page, ALWAYS_SHOWN).toBe(0);
  });

  test("an airport stays clickable once it appears", async ({ page }) => {
    await mockFlightApi(page);
    await page.goto("/");
    await waitForMapReady(page);

    await setMapView(page, SWEDEN.lat, SWEDEN.lon, CLOSE_ZOOM);
    await drawn(page, MINOR).toBe(1);
    await clickAirport(page, MINOR);

    // The layer's zoom filter changes what is drawn on every zoom, so this
    // guards the thing most likely to break silently: an airport that renders
    // but no longer hit-tests. The dossier heading is the airport's name,
    // falling back to its code.
    await expect(page.getByRole("heading", { name: /Norrk|NRK/ })).toBeVisible({ timeout: 10_000 });
  });
});
