import { expect, test, type Page } from "@playwright/test";
import { mockFlightApi, renderedPlanes, setMapView, waitForMapReady } from "./helpers";

// Petter's recording (3 Nov, Stockholm/Arlanda): crossing zoom 7 to 8 swapped
// the whole set of drawn planes — a handful at the wide view, a different
// handful zoomed in. Below CLUSTER_FETCH_MAX_ZOOM the map draws the thinned
// active-traffic overview; at or above it the full /live set, parked aircraft
// included, and the two sources don't hold the same planes. The switch must
// change how dense the map is, not which planes are on it (Saito's #2 in
// section9-hq #49; see main.ts and map/overviewHold.ts).

const BASE = { lat: 59.5, lon: 18.0 }; // Stockholm/Arlanda
// Narrow enough at z8 that the two lower planes are still on screen.
const plane = (icao24: string, lat: number, lon: number, onGround = false) => ({
  icao24,
  callsign: icao24.toUpperCase(),
  observedAt: new Date(Date.now() - 60_000).toISOString(),
  latitude: lat,
  longitude: lon,
  headingDeg: 90,
  onGround,
});

const A = plane("aaaaaa", BASE.lat, BASE.lon - 1);
const B = plane("bbbbbb", BASE.lat, BASE.lon + 1);
const G = plane("dddddd", BASE.lat - 1, BASE.lon, true); // parked on the apron
const H = plane("eeeeee", BASE.lat + 1, BASE.lon, true);

const drawn = async (page: Page): Promise<string[]> => (await renderedPlanes(page)).map((p) => p.icao24).sort();

/** The overview request's own width: the wide (z6) view is the one this spec drives. */
const overviewSpanDeg = (url: string): number => {
  const q = new URL(url).searchParams;
  return Number(q.get("lonMax")) - Number(q.get("lonMin"));
};

test.describe("crossing the zoom-8 threshold", () => {
  test("planes on screen stay on screen: the threshold changes density, not membership", async ({ page }) => {
    test.slow(); // software WebGL: each step is a rendered frame
    let overviewCalls = 0;
    await mockFlightApi(page, { clusters: [] });
    await page.route("**/api/flights/live/overview*", (route) => {
      overviewCalls++;
      // First frame: two aircraft. Afterwards bbbbbb has landed and the
      // overview's one-per-cell thinning no longer returns it.
      return route.fulfill({ json: { planes: overviewCalls === 1 ? [A, B] : [A], clusters: [] } });
    });
    await page.route(/\/api\/flights\/live(\?|$)/, (route) => route.fulfill({ json: [A, B, G] }));

    await page.goto("/");
    await waitForMapReady(page);
    await setMapView(page, BASE.lat, BASE.lon, 6);
    await expect.poll(() => drawn(page), { timeout: 15_000 }).toEqual(["aaaaaa", "bbbbbb"]);

    // In over the threshold: the full set, the parked aircraft included.
    await setMapView(page, BASE.lat, BASE.lon, 8);
    await expect.poll(() => drawn(page), { timeout: 15_000 }).toEqual(["aaaaaa", "bbbbbb", "dddddd"]);

    // Back out. The overview returns neither bbbbbb (landed) nor the parked
    // dddddd — both were on screen, so both are still drawn.
    await setMapView(page, BASE.lat, BASE.lon, 6);
    await expect.poll(() => drawn(page), { timeout: 15_000 }).toEqual(["aaaaaa", "bbbbbb", "dddddd"]);
  });

  test("the frame on screen is held until the new source's response arrives", async ({ page }) => {
    test.slow(); // software WebGL: each step is a rendered frame
    let liveCalls = 0;
    let releaseSecondLive: () => void = () => {};
    const secondLiveHeld = new Promise<void>((resolve) => (releaseSecondLive = resolve));
    await mockFlightApi(page, { clusters: [] });
    await page.route("**/api/flights/live/overview*", (route) =>
      // The wide view is the only one this test drives; it reports bbbbbb.
      route.fulfill({ json: { planes: overviewSpanDeg(route.request().url()) > 25 ? [A, B] : [A], clusters: [] } }),
    );
    await page.route(/\/api\/flights\/live(\?|$)/, async (route) => {
      liveCalls++;
      // The first /live frame is the one this test leaves in the view cache:
      // it was taken before bbbbbb's first report. The second, for the same
      // view, is held here until the test says.
      if (liveCalls > 1) await secondLiveHeld;
      await route.fulfill({ json: liveCalls > 1 ? [A, B, G, H] : [A, G] }).catch(() => {});
    });

    await page.goto("/");
    await waitForMapReady(page);
    await setMapView(page, BASE.lat, BASE.lon, 6);
    await expect.poll(() => drawn(page), { timeout: 15_000 }).toEqual(["aaaaaa", "bbbbbb"]);

    // A first look in, before bbbbbb was reporting on the live feed.
    await setMapView(page, BASE.lat, BASE.lon, 8);
    await expect.poll(() => drawn(page), { timeout: 15_000 }).toEqual(["aaaaaa", "dddddd"]);

    // Back out: bbbbbb is on the wide view's frame, and dddddd — drawn from
    // /live a moment ago — is held with it.
    await setMapView(page, BASE.lat, BASE.lon, 6);
    await expect.poll(() => drawn(page), { timeout: 15_000 }).toEqual(["aaaaaa", "bbbbbb", "dddddd"]);

    // In again, with the response for this view still in flight. The cached
    // /live frame has no bbbbbb in it: drawing it here would swap the set out
    // from under the user before the real one lands.
    await setMapView(page, BASE.lat, BASE.lon, 8);
    await page.waitForTimeout(800); // past the viewport debounce; the response is held
    expect(await drawn(page), "frame held while the new source's response is in flight").toEqual(["aaaaaa", "bbbbbb", "dddddd"]);

    releaseSecondLive();
    await expect.poll(() => drawn(page), { timeout: 15_000 }).toEqual(["aaaaaa", "bbbbbb", "dddddd", "eeeeee"]);
  });
});
