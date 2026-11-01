import { expect, test } from "@playwright/test";
import { LIVE_FIXTURE, mockFlightApi, renderedPlanes, waitForMapReady } from "./helpers";

// Search a flight before it flies -> Watch -> "not airborne yet" -> the server matches a live
// aircraft -> the watch list offers it -> it is selected on the map.

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

test("search, watch, not airborne, airborne, select on the map", async ({ page }) => {
  await mockFlightApi(page);
  let airborne = false;
  const queries: string[] = [];
  await page.route("**/api/schedule/search*", (route) => {
    queries.push(new URL(route.request().url()).search);
    return route.fulfill({ json: [row(airborne)] });
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
  await expect(item.locator(".watch-panel-show")).toHaveCount(0);

  // Stored locally: survives a reload.
  await page.reload();
  await waitForMapReady(page);
  await expect(toggle).toContainText("(1)");

  // The aircraft appears in live state; reopening the panel refreshes the watched flight.
  airborne = true;
  await toggle.click();
  const show = page.locator(".watch-panel-item .watch-panel-show");
  await expect(show).toBeVisible();
  await show.click();

  await expect
    .poll(async () => (await renderedPlanes(page)).some((p) => p.icao24 === plane.icao24 && p.selected), { timeout: 10_000 })
    .toBe(true);
  await expect(page.getByText(`ICAO24 ${plane.icao24.toUpperCase()}`)).toBeVisible();
});
