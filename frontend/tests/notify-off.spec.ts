import { test, expect } from "@playwright/test";
import { LIVE_FIXTURE, freezeClock, mockFlightApi, seedWatched, waitForMapReady } from "./helpers";

// VITE_NOTIFY is a build-time flag, off by default in production. The dev
// server every other spec uses turns it on; the production preview at 4173 runs
// the flag-off bundle. This spec pins the flag-off request pattern for the watch
// poll: a watched flight that is not airborne must make no per-flight /live
// fetch. That fetch exists only to feed the notification detector (its on-ground
// ticks are what prove a landing), so the default build must not pay for it.
const PREVIEW_URL = "http://localhost:4173/";
const plane = LIVE_FIXTURE.find((p) => p.callsign === "SAS2112")!;

const row = {
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
  icao24: plane.icao24,
  airborne: false,
};
const TODAY = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Stockholm" });
const WATCHED = [{ flightNumber: "SK2112", date: TODAY, airport: "ARN", label: "LHR → ARN" }];

test.setTimeout(120_000);

test("with VITE_NOTIFY off, a watched not-airborne flight makes no per-flight /live fetch", async ({ page }) => {
  await freezeClock(page);
  await mockFlightApi(page);
  let liveFetches = 0;
  await page.route("**/api/flights/*/live*", (route) => {
    liveFetches++;
    return route.fulfill({ json: null });
  });
  await page.route("**/api/schedule/search*", (route) => route.fulfill({ json: [row] }));
  await seedWatched(page, WATCHED);

  await page.goto(PREVIEW_URL, { waitUntil: "load" });
  await waitForMapReady(page, 20_000);
  await page.clock.runFor(61_000); // one watch poll

  expect(liveFetches, "the flag-off build must not fetch a not-airborne flight's live position").toBe(0);
});
