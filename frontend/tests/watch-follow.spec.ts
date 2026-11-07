import { expect, test } from "@playwright/test";
import { LIVE_FIXTURE, mockFlightApi, planeLayerIds, renderedPlanes, renderedWatchedAirports, seedWatched, setMapView, waitForMapReady, withMap } from "./helpers";

// The app boots MapLibre under software WebGL: a couple of map views and a
// background poll per test need more than the default test budget on a busy box.
test.setTimeout(60_000);

// What watching a flight is for: the watched plane is highlighted on the map,
// Go to flies to it without the Watch panel, the search box finds it (airborne
// or not), and a departure raises a toast - all from the background poll, not
// from the panel being open.

const plane = LIVE_FIXTURE.find((p) => p.callsign === "SAS2112")!; // airborne in the fixture
const row = (airborne: boolean) => ({
  flightNumber: "SK2112",
  callsign: "SAS2112",
  direction: "arrivals",
  airport: "ARN",
  departureIata: "LHR",
  arrivalIata: "ARN",
  scheduled: "2026-11-02T10:05:00Z",
  estimated: "2026-11-02T10:20:00Z",
  actual: null,
  gate: "F12",
  terminal: "5",
  statusCode: "SCH",
  status: "Scheduled",
  icao24: airborne ? plane.icao24 : null,
  airborne,
});
const WATCHED = [{ flightNumber: "SK2112", date: "2026-11-02", airport: "ARN", label: "LHR → ARN" }];

test("a watched, airborne flight is highlighted, drawn among traffic and exempt from declutter", async ({ page }) => {
  await mockFlightApi(page);
  // The viewport's /live omits the watched plane (so it can only be drawn from
  // the watch poll's kept position) but carries a decoy at exactly that
  // position: ordinary traffic there is hidden by declutter, a watched plane is not.
  const decoy = { ...plane, icao24: "abcdef", callsign: "DECOY" };
  await page.route(/\/api\/flights\/live\?/, (route) => route.fulfill({ json: [...LIVE_FIXTURE.filter((p) => p.icao24 !== plane.icao24), decoy] }));
  await page.route("**/api/schedule/search*", (route) => route.fulfill({ json: [row(true)] }));
  await seedWatched(page, WATCHED);
  await page.goto("/");
  await waitForMapReady(page);
  await setMapView(page, plane.latitude, plane.longitude, 8);

  // Waited on as a whole: the watched plane is drawn from the watch poll's own
  // position before the viewport's /live response lands, so "an ordinary plane
  // is drawn too" is only true once both sources are in.
  await expect
    .poll(
      async () => {
        const planes = await renderedPlanes(page);
        return (
          planes.find((p) => p.icao24 === plane.icao24)?.watched === true &&
          planes.some((p) => !p.watched && !p.selected && p.icao24 !== plane.icao24) &&
          // The decoy at the watched plane's exact spot stays hidden (declutter).
          !planes.some((p) => p.icao24 === "abcdef")
        );
      },
      { timeout: 10_000 },
    )
    .toBe(true);
});

test("Go to flies the map to the watched plane from the search-box chip", async ({ page }) => {
  await mockFlightApi(page);
  await page.route("**/api/schedule/search*", (route) => route.fulfill({ json: [row(true)] }));
  await seedWatched(page, WATCHED);
  await page.goto("/");
  await waitForMapReady(page);
  await setMapView(page, plane.latitude, plane.longitude, 10);

  // The chip is there at once (the list is local); its airborne state comes from
  // the background poll.
  const chip = page.locator(".flight-search-watched .flight-search-chip");
  await expect(chip).toContainText("SK2112");
  await expect(chip).toHaveClass(/flight-search-chip--airborne/);
  await chip.click();

  await expect
    .poll(async () => (await renderedPlanes(page)).some((p) => p.icao24 === plane.icao24 && p.selected), { timeout: 10_000 })
    .toBe(true);
  // The map actually moved to it.
  await expect
    .poll(
      async () => {
        const c = await withMap(page, (map) => map.getCenter());
        return Math.hypot(c.lat - plane.latitude, c.lon - plane.longitude);
      },
      { timeout: 10_000 },
    )
    .toBeLessThan(0.5);
});

test("the search box lists a matching watched flight before it is airborne, and its origin is marked", async ({ page }) => {
  await mockFlightApi(page);
  await page.route("**/api/schedule/search*", (route) => route.fulfill({ json: [row(false)] }));
  await seedWatched(page, WATCHED);
  await page.goto("/");
  await waitForMapReady(page);
  // Look at the departure airport (LHR), where the not-yet-airborne marker is.
  await setMapView(page, 51.47, -0.45, 7);

  // Not-yet-airborne watched flight: its origin airport is ringed on the map.
  await expect
    .poll(async () => (await renderedWatchedAirports(page)).some((a) => a.code === "LHR" && a.flightNumber === "SK2112"), { timeout: 10_000 })
    .toBe(true);

  const input = page.locator(".flight-search-input").first();
  // Typed as the IATA number -> listed, with the schedule line and "not airborne yet".
  await input.fill("SK2112");
  const watchedRow = page.locator(".flight-search-option--watched");
  await expect(watchedRow).toContainText("SK2112");
  await expect(watchedRow).toContainText("not airborne yet");
  await expect(watchedRow).toContainText("LHR → ARN");

  // The ICAO callsign finds it too.
  await input.fill("SAS");
  await expect(page.locator(".flight-search-option--watched")).toContainText("SK2112");
});

test("a watched flight going airborne raises a toast once, and is drawn on the map", async ({ page }) => {
  await page.clock.install();
  await mockFlightApi(page);
  let airborne = false;
  // Recorded so the second poll below is proven to have run, not merely waited for.
  const searches: string[] = [];
  await page.route("**/api/schedule/search*", (route) => {
    searches.push(route.request().url());
    return route.fulfill({ json: [row(airborne)] });
  });
  await seedWatched(page, WATCHED);
  await page.goto("/");
  await waitForMapReady(page);

  // Not airborne on the first poll: no toast.
  expect(await page.locator(".watch-toast").isVisible()).toBe(false);

  // It departs; the next 60 s poll learns it.
  airborne = true;
  await page.clock.runFor(61_000);

  const toast = page.locator(".watch-toast");
  await expect(toast).toBeVisible();
  await expect(toast).toContainText("SK2112 is airborne");

  // The plane is drawn (a source-level read: the clock holds the frames).
  await expect.poll(async () => (await planeLayerIds(page)).includes(plane.icao24), { timeout: 10_000 }).toBe(true);

  // It fires once, not once per poll: dismiss it, then let another poll see the
  // same flight still airborne. The poll runs (a fresh schedule request) and
  // raises no second toast.
  await toast.locator(".watch-toast-close").click();
  await expect(toast).toBeHidden();
  const pollsBefore = searches.length;
  await page.clock.runFor(61_000);
  await expect.poll(() => searches.length, { timeout: 10_000 }).toBeGreaterThan(pollsBefore);
  await expect.poll(() => toast.isVisible(), { timeout: 10_000 }).toBe(false);
});
