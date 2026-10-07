import { expect, test, type Page } from "@playwright/test";
import { mockFlightApi, planeTarget, renderedPlanes, setMapView, withMap } from "./helpers";

// Planes are drawn by the map itself (map/planes.ts): symbol layers on the GL
// canvas, not DOM elements. These check what that drawing has to get right:
// sizes that follow a continuous zoom, clicks hit-tested against what is
// drawn, overlap hiding, and the selected plane above everything else.

const BASE = { lat: 59.65, lon: 17.93 };
// Arlanda's reference point in worldMapData.ts.
const ARN = { lat: 59.65112, lon: 17.93073 };
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

const plane = (icao24: string, callsign: string, lat: number, lon: number, headingDeg: number | null = 90) => ({
  icao24,
  callsign,
  observedAt: minutesAgo(1),
  latitude: lat,
  longitude: lon,
  headingDeg,
  onGround: false,
});
type Plane = ReturnType<typeof plane>;

/** Serves `list` as /live (a function: per request), and each plane's own /live and search hit. */
async function serve(page: Page, list: Plane[] | (() => Plane[]), zoom: number, at = BASE) {
  const current = typeof list === "function" ? list : () => list;
  await mockFlightApi(page);
  await page.route(/\/api\/flights\/live(\?|$)/, (route) => route.fulfill({ json: current() }));
  await page.route("**/api/flights/*/live*", (route) => {
    const icao24 = new URL(route.request().url()).pathname.split("/")[3];
    const p = current().find((x) => x.icao24 === icao24);
    return p ? route.fulfill({ json: { ...p, id: 0, altitudeM: 10_000, velocityMs: 230, verticalRateMs: 0, agentSource: "opensky" } }) : route.fulfill({ status: 404, json: null });
  });
  await page.route("**/api/flights/search*", (route) => {
    const q = new URL(route.request().url()).searchParams.get("q")?.trim() ?? "";
    return route.fulfill({ json: current().filter((p) => q && p.callsign.startsWith(q)) });
  });
  await page.goto("/");
  await page.waitForSelector(".map-container", { timeout: 10_000 });
  await setMapView(page, at.lat, at.lon, zoom);
}

const callsigns = async (page: Page) => (await renderedPlanes(page)).map((p) => p.callsign).sort();

/** Selects a plane the way a user can whether or not it is drawn: the flight-number search. */
async function selectBySearch(page: Page, callsign: string) {
  await page.getByPlaceholder("Search by flight number…").fill(callsign);
  await page.locator("#flight-search-listbox .flight-search-callsign", { hasText: callsign }).first().click();
  await expect(page.locator(".details-panel")).toBeVisible();
}

/**
 * The drawn glyph's extent, page px: the bounding box of the pixels within
 * a small distance of `rgb` in a `box`-sized square around (x, y) of a
 * screenshot. Measures what the GPU drew, not what the app asked for.
 */
async function glyphExtent(page: Page, x: number, y: number, rgb: [number, number, number], box = 120): Promise<{ width: number; height: number }> {
  const png = await page.screenshot({ clip: { x: x - box / 2, y: y - box / 2, width: box, height: box } });
  return page.evaluate(
    async ({ b64, rgb }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.width;
      c.height = img.height;
      const ctx = c.getContext("2d")!;
      ctx.drawImage(img, 0, 0);
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (let i = 0; i < d.length; i += 4) {
        if (Math.abs(d[i] - rgb[0]) + Math.abs(d[i + 1] - rgb[1]) + Math.abs(d[i + 2] - rgb[2]) > 90) continue;
        const px = (i / 4) % c.width;
        const py = Math.floor(i / 4 / c.width);
        minX = Math.min(minX, px);
        maxX = Math.max(maxX, px);
        minY = Math.min(minY, py);
        maxY = Math.max(maxY, py);
      }
      return maxX < minX ? { width: 0, height: 0 } : { width: maxX - minX + 1, height: maxY - minY + 1 };
    },
    { b64: png.toString("base64"), rgb },
  );
}

/** One pixel of a screenshot, page px. */
async function pixel(page: Page, x: number, y: number): Promise<[number, number, number]> {
  const png = await page.screenshot({ clip: { x: Math.round(x), y: Math.round(y), width: 1, height: 1 } });
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = c.height = 1;
    const ctx = c.getContext("2d")!;
    ctx.drawImage(img, 0, 0);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return [r, g, b] as [number, number, number];
  }, png.toString("base64"));
}

// The theme's marker colours (FlightMap.css cyberpunk tokens).
const MARKER: [number, number, number] = [0x3c, 0xe0, 0xff];
const SELECTED: [number, number, number] = [0xff, 0xb6, 0x3c];
const near = (a: [number, number, number], b: [number, number, number]) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) < 90;

test.describe("planes drawn by the map", () => {
  test("icon size follows a fractional zoom smoothly, between the whole levels' sizes", async ({ page }) => {
    // Pointing north, so the dart's height on screen is its length.
    await serve(page, [plane("aaaaaa", "SOLO", BASE.lat, BASE.lon, 0)], 15);
    await expect.poll(async () => (await renderedPlanes(page)).length, { timeout: 10_000 }).toBe(1);
    await page.locator(".boot-screen").waitFor({ state: "detached", timeout: 15_000 });
    const measure = async (zoom: number) => {
      await setMapView(page, BASE.lat, BASE.lon, zoom);
      await page.waitForTimeout(500);
      const p = (await renderedPlanes(page))[0];
      return { size: p.size, drawn: (await glyphExtent(page, p.x, p.y, MARKER)).height };
    };
    // z15 52 px, z16 43 px (ICON_SIZE_BY_ZOOM): far enough apart to see on screen.
    const z15 = await measure(15);
    const z155 = await measure(15.5);
    const z16 = await measure(16);
    expect(z15.size).toBe(52);
    expect(z16.size).toBe(43);
    expect(z155.size).toBeCloseTo(47.5, 5);
    // What the map really drew is in proportion to that size at every zoom
    // (the dart's solid fill spans about half its box from tip to tail).
    const ratios = [z15, z155, z16].map((m) => m.drawn / m.size);
    for (const r of ratios) expect(r, `drawn/size ${ratios.map((x) => x.toFixed(3)).join(", ")}`).toBeGreaterThan(0.45);
    expect(Math.max(...ratios) - Math.min(...ratios), `drawn/size ${ratios.map((x) => x.toFixed(3)).join(", ")}`).toBeLessThan(0.06);
    // In between, not snapped to either level.
    expect(z155.drawn).toBeLessThan(z15.drawn);
    expect(z155.drawn).toBeGreaterThan(z16.drawn);
  });

  test("clicking a plane selects it; a click beside it does not", async ({ page }) => {
    await serve(page, [plane("aaaaaa", "LEFT1", BASE.lat, BASE.lon - 0.3), plane("bbbbbb", "RIGHT1", BASE.lat, BASE.lon + 0.3)], 10);
    await expect.poll(() => callsigns(page), { timeout: 10_000 }).toEqual(["LEFT1", "RIGHT1"]);
    await page.locator(".boot-screen:not(.boot-screen--hidden)").waitFor({ state: "detached", timeout: 15_000 });
    const right = (await renderedPlanes(page)).find((p) => p.icao24 === "bbbbbb")!;

    // Well outside its icon box: nothing.
    await page.mouse.click(right.x, right.y + right.size * 1.5);
    await page.waitForTimeout(300);
    await expect(page.locator(".details-panel")).toHaveCount(0);

    // Hovering it shows it is clickable; dragging from it does not (the
    // canvas cursor would hide the map's own grabbing cursor).
    await page.mouse.move(right.x, right.y);
    const cursor = () => withMap(page, (map) => map.gl.getCanvas().style.cursor);
    await expect.poll(cursor).toBe("pointer");
    await page.mouse.down();
    await page.mouse.move(right.x - 60, right.y, { steps: 5 });
    await expect.poll(cursor).toBe("");
    await page.mouse.up();
    await page.waitForTimeout(500);

    // Anywhere on its icon box selects it, as the DOM marker's box did.
    const moved = (await renderedPlanes(page)).find((p) => p.icao24 === "bbbbbb")!;
    await page.mouse.click(moved.x + moved.size * 0.4, moved.y - moved.size * 0.4);
    await expect(page.getByText("ICAO24 BBBBBB")).toBeVisible({ timeout: 5_000 });
    await expect.poll(async () => (await renderedPlanes(page)).filter((p) => p.selected).map((p) => p.label), { timeout: 5_000 }).toEqual(["RIGHT1"]);
  });

  test("of overlapping planes only the first discovered is drawn, and it stays first", async ({ page }) => {
    const first = plane("aaaaaa", "FIRST", BASE.lat, BASE.lon);
    const crowd = [first, plane("bbbbbb", "SECOND", BASE.lat + 0.001, BASE.lon + 0.001), plane("cccccc", "THIRD", BASE.lat - 0.001, BASE.lon + 0.002)];
    const alone = plane("dddddd", "ALONE", BASE.lat, BASE.lon + 0.6);
    let requests = 0;
    // Later responses list the crowd in reverse: discovery order is this map's, not the server's latest.
    await serve(page, () => (requests++ === 0 ? [...crowd, alone] : [alone, ...crowd.slice().reverse()]), 9);
    await expect.poll(() => callsigns(page), { timeout: 10_000 }).toEqual(["ALONE", "FIRST"]);

    await page.waitForTimeout(3_500); // past the /live cache's freshness, so a pan refetches
    const before = requests;
    await setMapView(page, BASE.lat + 0.05, BASE.lon, 9);
    await expect.poll(() => requests, { timeout: 10_000 }).toBeGreaterThan(before);
    await page.waitForTimeout(500);
    expect(await callsigns(page)).toEqual(["ALONE", "FIRST"]);
  });

  test("the selected plane is drawn even where it overlaps one discovered before it", async ({ page }) => {
    await serve(page, [plane("aaaaaa", "FIRST", BASE.lat, BASE.lon), plane("bbbbbb", "SECOND", BASE.lat + 0.001, BASE.lon + 0.001)], 10);
    await expect.poll(() => callsigns(page), { timeout: 10_000 }).toEqual(["FIRST"]);

    await selectBySearch(page, "SECOND");
    // SECOND is drawn (selected, with its callsign chip) and hides the plane under it.
    await expect
      .poll(async () => (await renderedPlanes(page)).map((p) => `${p.callsign}${p.selected ? ` selected ${p.label}` : ""}`), { timeout: 10_000 })
      .toEqual(["SECOND selected SECOND"]);
  });

  test("the selected plane is drawn above an airport's dot and code", async ({ page }) => {
    // Parked on Arlanda's reference point, pointing east: its nose lies on the ARN code chip.
    await serve(page, [plane("aaaaaa", "ONARN", ARN.lat, ARN.lon, 90)], 11, ARN);
    await expect.poll(() => callsigns(page), { timeout: 10_000 }).toEqual(["ONARN"]);
    await expect.poll(() => withMap(page, (map) => map.renderedAirports().some((a) => a.code === "ARN")), { timeout: 10_000 }).toBe(true);

    await selectBySearch(page, "ONARN");
    await expect.poll(async () => (await renderedPlanes(page)).find((p) => p.selected)?.label, { timeout: 10_000 }).toBe("ONARN");
    await page.waitForTimeout(1_200); // the selection's flyTo
    const p = (await renderedPlanes(page)).find((q) => q.selected)!;
    // The plane's body and its nose (where the ARN chip starts, 10 px right of
    // the dot) are the selected colour: the airport is underneath.
    expect(near(await pixel(page, p.x, p.y), SELECTED), "plane centre").toBe(true);
    expect(near(await pixel(page, p.x + 13, p.y), SELECTED), "plane nose over the ARN chip").toBe(true);
    // And a click there selects nothing else (the plane wins over the airport under it).
    expect(await withMap(page, (map, lat: number, lon: number) => map.hitAt(map.project(lat, lon))?.id, ARN.lat, ARN.lon)).toBe("plane:aaaaaa");
    await planeTarget(page, "aaaaaa").click();
    await expect(page.locator("#airport-details-panel-heading")).toHaveCount(0);
  });
});
