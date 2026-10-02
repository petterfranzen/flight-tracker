import { expect, test } from "@playwright/test";
import { AIRPORTS } from "./world";
import {
  POSITION_TOLERANCE_DEG,
  centre,
  clickPlane,
  drag,
  expectCentredOn,
  jumpTo,
  pickVisiblePlane,
  planeMarkers,
  startHarness,
  wheelZoom,
  zoomLevel,
} from "./harness";

// Regular use of the app, end to end, against a simulated world whose
// aircraft move in real time (see world.ts / harness.ts). Every step is
// screenshotted (attached to the report, video and trace recorded too) and
// health-checked: basemap really drawn, every plane marker on screen at its
// aircraft's true position, no page errors. Runs as its own serial CI step:
// the position checks are timing-sensitive.

test.describe.configure({ mode: "serial" });
test.use({ viewport: { width: 1440, height: 900 }, video: "on", trace: "on" });

const ARN = AIRPORTS.find((a) => a.iata === "ARN")!;
const AMS = AIRPORTS.find((a) => a.iata === "AMS")!;

async function boot(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.waitForSelector(".boot-screen");
  await page.waitForSelector(".boot-screen--hidden, body:not(:has(.boot-screen))", { timeout: 20_000 });
  await page.waitForSelector(".cluster-icon, .plane-icon", { timeout: 10_000 });
}

test.describe("user journeys @scenario", () => {
  test("first visit: boot, pan around, zoom in and out", async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    const h = await startHarness(page, testInfo);
    await h.step("boot screen gone, clusters on the cyberpunk map", () => boot(page));
    await expect(page.locator("html")).toHaveAttribute("data-theme", "cyberpunk");

    await h.step("pan east", () => drag(page, -300, 0));
    await h.step("pan back west and north", () => drag(page, 300, 150));
    await h.step("zoom to Arlanda with the scroll wheel", async () => {
      await jumpTo(page, ARN.lat, ARN.lon, 6);
      await wheelZoom(page, 3);
    });
    expect(await zoomLevel(page)).toBeGreaterThanOrEqual(8);
    await h.step("zoom in further", () => wheelZoom(page, 2));
    expect((await planeMarkers(page)).length, "individual planes at z10 near ARN").toBeGreaterThan(0);
    await h.step("pan around zoomed in", () => drag(page, -250, 120));
    await h.step("zoom back out past the cluster threshold", () => wheelZoom(page, -4));
    await expect(page.locator(".cluster-icon").first()).toBeVisible();
    await h.step("zoom in again: drawn from cache, still correct", () => wheelZoom(page, 4));
    expect(h.restarts, "restart only on page load (status says the window is open, so never)").toBe(0);
  });

  test("select a plane, favourite it, zoom out to see its whole trajectory", async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    const h = await startHarness(page, testInfo);
    await h.step("boot", () => boot(page));
    await h.step("zoom in at Arlanda", () => jumpTo(page, ARN.lat, ARN.lon, 10));
    const callsign = await pickVisiblePlane(page, ARN);
    await h.step(`select ${callsign}`, () => clickPlane(page, callsign));
    await expectCentredOn(page, h, callsign, "after selecting");
    const a = h.world.byCallsign(callsign)!;
    const dossier = h.world.dossier(a);
    await expect(page.locator(".details-panel")).toContainText(dossier.originAirportIata);
    await expect(page.locator(".details-panel")).toContainText(dossier.destinationAirportIata);

    await h.step("favourite the aircraft", () => page.locator(".details-panel-favorite-toggle").first().click());
    await expect(page.locator(".details-panel-favorite-toggle").first()).toHaveClass(/--active/);

    await h.step("zoom out to see the whole trajectory", () => wheelZoom(page, -3));
    const route = page.locator("path.route-line");
    await expect(route).toBeVisible();
    // The trail covers the whole leg: 40 minutes ≈ 5° of flight, so at z7 it
    // must span far more than a point, and end at the aircraft.
    const bbox = await route.boundingBox();
    expect(Math.max(bbox!.width, bbox!.height), "trajectory drawn as a long line").toBeGreaterThan(150);
    const selected = (await planeMarkers(page)).find((m) => m.callsign === callsign);
    expect(selected, "selected aircraft still drawn when zoomed out").toBeTruthy();
  });

  test("favourites always take you to the aircraft's true current position", async ({ page }, testInfo) => {
    test.setTimeout(150_000);
    const h = await startHarness(page, testInfo);
    await h.step("boot", () => boot(page));
    await h.step("zoom in at Arlanda", () => jumpTo(page, ARN.lat, ARN.lon, 10));
    const first = await pickVisiblePlane(page, ARN);
    await h.step(`select and favourite ${first}`, async () => {
      await clickPlane(page, first);
      await page.locator(".details-panel-favorite-toggle").first().click();
    });
    await h.step("open favourites (starts its live-status polling)", async () => {
      await page.locator(".details-panel-close").click();
      await page.locator(".favorites-panel-toggle:visible, .favorites-panel-fab:visible").first().click();
    });
    await expect(page.locator(".favorites-panel-item-status").first()).toHaveText("live now");

    await h.step("go elsewhere (Amsterdam) and let time pass", async () => {
      await jumpTo(page, AMS.lat, AMS.lon, 9);
      await page.waitForTimeout(12_000); // favourites last polled up to 20s ago
    });
    await h.step(`click ${first} in favourites`, () => page.locator(".favorites-panel-item-select", { hasText: first }).click());
    await expectCentredOn(page, h, first, "after clicking the favourite");
    const drawn = (await planeMarkers(page)).find((m) => m.callsign === first)!;
    const truth = h.world.positionAt(h.world.byCallsign(first)!);
    expect(Math.hypot(drawn.lat - truth.lat, drawn.lon - truth.lon), "favourite drawn at its true position").toBeLessThan(POSITION_TOLERANCE_DEG);
  });

  test("search by flight number and by airport (KLR / Kalmar / ESMQ)", async ({ page }, testInfo) => {
    test.setTimeout(150_000);
    const h = await startHarness(page, testInfo);
    await h.step("boot", () => boot(page));

    await h.step("type a flight number", () => page.locator(".flight-search-input").fill("BRX10"));
    const hits = page.locator("#flight-search-listbox .flight-search-callsign");
    await expect(hits.first()).toBeVisible();
    const pickedByNumber = (await hits.first().textContent())!.trim();
    await page.waitForTimeout(6_000); // the result's position ages while the user reads the list
    await h.step(`select ${pickedByNumber} from the results`, () => hits.first().click());
    await expectCentredOn(page, h, pickedByNumber, "after picking a flight-number result");
    await page.locator(".details-panel-close").click();

    for (const query of ["KLR", "Kalmar", "ESMQ"]) {
      await h.step(`airport search: ${query}`, async () => {
        const toggle = page.locator(".flight-search-advanced-toggle");
        if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
        await page.getByPlaceholder("Search by airport (name, IATA, or ICAO)…").fill(query);
        await expect(page.locator("#flight-search-route-listbox .flight-search-callsign").first()).toBeVisible();
      });
      const shown = await page.locator("#flight-search-route-listbox .flight-search-callsign").allTextContents();
      const expected = h.world.searchByAirport("ESMQ").map((a) => a.callsign).sort().slice(0, 8);
      expect(shown.map((s) => s.trim()).sort(), `results for ${query}: every flight to/from Kalmar`).toEqual(expected);
    }
    const toKalmar = (await page.locator("#flight-search-route-listbox .flight-search-callsign").first().textContent())!.trim();
    await h.step(`select ${toKalmar} from the airport results`, () => page.locator("#flight-search-route-listbox .flight-search-callsign").first().click());
    await expectCentredOn(page, h, toKalmar, "after picking an airport-search result");
    await expect(page.locator(".details-panel")).toContainText("KLR");
  });

  test("reselecting across the map, airport dossier, live updates, theme round trip", async ({ page }, testInfo) => {
    test.setTimeout(150_000);
    const h = await startHarness(page, testInfo);
    await h.step("boot", () => boot(page));
    await h.step("zoom in at Arlanda", () => jumpTo(page, ARN.lat, ARN.lon, 10));
    const atArn = await pickVisiblePlane(page, ARN);
    await h.step(`select ${atArn}`, () => clickPlane(page, atArn));
    await h.step("zoom out, go to Amsterdam, zoom in", async () => {
      await wheelZoom(page, -4);
      await jumpTo(page, AMS.lat, AMS.lon, 6);
      await wheelZoom(page, 4);
    });
    const atAms = await pickVisiblePlane(page, AMS);
    await h.step(`select ${atAms}`, () => clickPlane(page, atAms));
    await expectCentredOn(page, h, atAms, "after reselecting at AMS (must not fly back to ARN)");
    await page.locator(".details-panel-close").click();

    await h.step("watch live updates for 10s", () => page.waitForTimeout(10_000));
    await h.step("open the Schiphol airport dossier", async () => {
      await page.locator(".default-airport-icon", { hasText: "AMS" }).first().click();
      await expect(page.locator("#airport-details-panel-heading")).toBeVisible();
    });
    await expect(page.locator(".details-panel")).toContainText("AMS / EHAM");
    await expect(page.locator(".details-panel")).toContainText("Amsterdam");
    await page.locator(".details-panel-close").click();

    await h.step("switch to the plain theme", () => page.locator(".theme-toggle-btn").click());
    await expect(page.locator("html")).not.toHaveAttribute("data-theme", /.+/);
    await h.step("and back to cyberpunk: basemap renders again", async () => {
      await page.locator(".theme-toggle-btn").click();
      await page.waitForSelector(".boot-screen--hidden, body:not(:has(.boot-screen))", { timeout: 20_000 });
    });
    const c = await centre(page);
    expect(Math.abs(c.lat - AMS.lat) < 2, "view kept across the theme toggle").toBe(true);
  });
});
