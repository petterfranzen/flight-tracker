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

test("on a phone the new watch entry is visible without scrolling the panel, and its stop-watching button clears the tap-target minimum", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockFlightApi(page);
  await page.route("**/api/schedule/search*", (route) => route.fulfill({ json: [row(false)] }));
  await page.goto("/");
  await waitForMapReady(page);

  await page.locator(".watch-panel-toggle").click();
  await page.locator(".watch-panel-flight").fill("sk2112");
  await page.locator(".watch-panel-date").fill("2026-11-02");
  await page.locator(".watch-panel-search").click();

  const result = page.locator(".watch-panel-result");
  await expect(result).toContainText("SK2112 LHR → ARN");
  await result.getByRole("button", { name: "Watch", exact: true }).click();

  const content = page.locator(".watch-panel-content");
  const item = page.locator(".watch-panel-item").last();
  await expect(item).toContainText("SK2112");

  // The panel keeps its own viewport-tied scroll box: short content grows it
  // (no fixed 320 px card cap any more, section9-hq#264) but it can never be
  // taller than the screen and scrolls itself when it is.
  const box = await content.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return {
      clientHeight: el.clientHeight,
      scrollHeight: el.scrollHeight,
      overflowY: getComputedStyle(el).overflowY,
      top: r.top,
      bottom: r.bottom,
    };
  });
  expect(box.overflowY).toBe("auto");
  expect(box.clientHeight).toBeLessThanOrEqual(844 - 32);
  expect(box.top).toBeGreaterThanOrEqual(15);
  expect(box.bottom).toBeLessThanOrEqual(844 - 15);
  expect(box.scrollHeight).toBeLessThanOrEqual(box.clientHeight); // everything fits for this one entry

  // ... and the new entry is inside that box without the user scrolling it.
  await expect
    .poll(
      async () => {
        const c = await content.boundingBox();
        const i = await item.boundingBox();
        if (!c || !i) return "no box";
        if (i.y < c.y - 1) return `above the box (item ${i.y} < ${c.y})`;
        if (i.y + i.height > c.y + c.height + 1) return `below the box (${i.y + i.height} > ${c.y + c.height})`;
        return "visible";
      },
      { timeout: 5_000 },
    )
    .toBe("visible");

  // The one control that removes a watch clears 44x44 on a phone.
  const remove = await page.locator(".watch-panel-remove").boundingBox();
  expect(remove).not.toBeNull();
  expect(remove!.width).toBeGreaterThanOrEqual(44);
  expect(remove!.height).toBeGreaterThanOrEqual(44);
});
