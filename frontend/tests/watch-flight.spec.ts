import { expect, test } from "@playwright/test";
import { LIVE_FIXTURE, mockFlightApi, renderedPlanes, seedWatched, waitForMapReady } from "./helpers";

// The app boots MapLibre under software WebGL: a couple of map views and a
// background poll per test need more than the default test budget on a busy box.
test.setTimeout(60_000);

// Search a flight before it flies -> Watch -> "not airborne yet" (stored locally,
// survives a reload) -> the background poll matches it to a live aircraft -> the
// watch list offers Go to -> it is selected on the map.

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

test("search, watch, not airborne, stored locally", async ({ page }) => {
  await mockFlightApi(page);
  const queries: string[] = [];
  await page.route("**/api/schedule/search*", (route) => {
    queries.push(new URL(route.request().url()).search);
    return route.fulfill({ json: [row(false)] });
  });
  await page.goto("/");
  await waitForMapReady(page);

  const toggle = page.locator(".watch-panel-toggle");
  await toggle.click();
  await page.locator(".watch-panel-flight").fill("sk2112");
  await page.locator(".watch-panel-date").fill("2026-11-02");
  await page.locator(".watch-panel-search").click();

  const result = page.locator(".watch-panel-result");
  await expect(result).toContainText("SK2112 LHR → ARN");
  await expect(result).toContainText("gate F12");
  await expect(result).toContainText("Scheduled");
  expect(queries[0]).toContain("flight=sk2112");
  await result.getByRole("button", { name: "Watch", exact: true }).click();

  const item = page.locator(".watch-panel-item");
  await expect(item).toContainText("SK2112");
  await expect(item.locator(".watch-panel-ground")).toHaveText("not airborne yet");
  await expect(item.locator(".watch-panel-goto")).toHaveCount(0);

  // Stored locally, like favorites (a browser-local list, no server round trip).
  const stored = await page.evaluate(() => localStorage.getItem("flighttracker:watchedFlights"));
  expect(stored).toContain("SK2112");
});

test("the panel offers Go to once the background poll finds it airborne", async ({ page }) => {
  await page.clock.install();
  await mockFlightApi(page);
  let airborne = false;
  await page.route("**/api/schedule/search*", (route) => route.fulfill({ json: [row(airborne)] }));
  await seedWatched(page, WATCHED);
  await page.goto("/");
  await waitForMapReady(page);

  // The aircraft appears in live state; the next background poll learns it.
  airborne = true;
  await page.clock.runFor(61_000);
  await page.locator(".watch-panel-toggle").click();
  const go = page.locator(".watch-panel-item .watch-panel-goto");
  await expect(go).toBeVisible();
  await go.click();
  await page.clock.runFor(2_000);

  await expect
    .poll(async () => (await renderedPlanes(page)).some((p) => p.icao24 === plane.icao24 && p.selected), { timeout: 10_000 })
    .toBe(true);
});
