import { expect, test, type Page } from "@playwright/test";
import { findMarkerNear, LIVE_FIXTURE, mockFlightApi, setMapView, waitForMapReady, waitForPlanes } from "./helpers";

/**
 * Keyboard and screen-reader follow-ups from the phone UX audit (section9-hq#421):
 * the dossier keeps focus across its rebuilds, takes focus on a new selection
 * and hands it back on close, a selection is announced, the panels' status
 * lines are stable live regions, and Tab starts at the search field.
 */

const target = LIVE_FIXTURE.find((p) => p.icao24 === "4aad15")!; // SEKHU

/** What has focus: its class list, or its tag when it has none. */
const focused = (page: Page) => page.evaluate(() => {
  const el = document.activeElement;
  return el ? el.getAttribute("class") || el.tagName.toLowerCase() : null;
});

const flightBox = (page: Page) => page.getByRole("combobox", { name: "Search for a flight by number" });

/** Whether the flight-number box has focus. */
const flightBoxFocused = (page: Page) => flightBox(page).evaluate((el) => el === document.activeElement);

const announcer = (page: Page) => page.locator("p.visually-hidden[role=status]", { hasText: /^Selected / });

/** A dossier with a known route, so both favourite toggles are enabled. */
async function mockDossier(page: Page): Promise<void> {
  await page.route(`**/api/aircraft/${target.icao24}*`, (route) =>
    route.fulfill({
      json: {
        icao24: target.icao24,
        registration: null,
        model: null,
        operator: null,
        originAirport: "LEAL",
        originAirportName: "Alicante-Elche",
        originAirportIata: "ALC",
        destinationAirport: "ESSA",
        destinationAirportName: "Stockholm Arlanda",
        destinationAirportIata: "ARN",
        flightMinutes: null,
        etaMinutes: null,
        cruisingAltitudeM: null,
        flightPhase: null,
        staleExplanation: null,
        legStartAt: null,
      },
    }),
  );
}

async function searchAndChoose(page: Page): Promise<void> {
  await flightBox(page).fill(target.callsign!);
  await page.locator(".flight-search-option", { hasText: target.callsign! }).waitFor();
  await flightBox(page).press("Enter");
  await expect(page.locator(".details-panel-title")).toHaveText(target.callsign!);
}

test.describe("dossier focus and announcements (desktop)", () => {
  test.beforeEach(async ({ page }) => {
    await mockFlightApi(page);
    await mockDossier(page);
    await page.goto("/");
    await waitForMapReady(page);
  });

  test("a search selection focuses the heading, is announced, and Close hands focus back to the search field", async ({ page }) => {
    await searchAndChoose(page);
    await expect.poll(() => focused(page)).toContain("details-panel-title");
    await expect(announcer(page)).toHaveText(`Selected ${target.callsign}`);

    await page.locator(".details-panel-close").click();
    await expect(page.locator(".details-panel")).toHaveCount(0);
    await expect.poll(() => flightBoxFocused(page)).toBe(true);
  });

  test("a rebuild keeps focus on the pressed favourite toggle; Escape returns it to the map", async ({ page }) => {
    await setMapView(page, target.latitude, target.longitude, 11);
    await waitForPlanes(page);
    await expect(async () => {
      await (await findMarkerNear(page, target.latitude, target.longitude)).click();
      await expect(page.locator(".details-panel")).toBeVisible({ timeout: 1_000 });
    }).toPass();
    await expect.poll(() => focused(page)).toContain("details-panel-title");

    // The second favourite toggle shares the first one's class: focus must stay on the one pressed.
    const routeToggle = page.locator(".details-panel-favorite-toggle").nth(1);
    await expect(routeToggle).toBeEnabled();
    await routeToggle.focus();
    await page.keyboard.press("Enter");
    await expect(routeToggle).toHaveAttribute("aria-pressed", "true");
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe("Favorite this route");

    await page.keyboard.press("Escape");
    await expect(page.locator(".details-panel")).toHaveCount(0);
    await expect.poll(() => focused(page)).toContain("maplibregl-canvas");
    await expect(announcer(page)).toHaveCount(0); // cleared, so the next selection is announced afresh
  });

  test("Tab starts at the search field, not the bottom dock", async ({ page }) => {
    await page.keyboard.press("Tab");
    await expect.poll(() => flightBoxFocused(page)).toBe(true);
  });

  test("search status lines and the watch panel's message are live regions that stay put", async ({ page }) => {
    // Flight search: "No matching flights" goes into one stable, hidden status element.
    const searchStatus = page.locator(".flight-search-panel > p[role=status]").first();
    await searchStatus.evaluate((el) => ((el as HTMLElement & { __stable?: boolean }).__stable = true));
    await flightBox(page).fill("ZZZNOPE");
    await expect(searchStatus).toHaveText("No matching flights");
    expect(await searchStatus.evaluate((el) => (el as HTMLElement & { __stable?: boolean }).__stable)).toBe(true);
    await flightBox(page).fill("");
    await expect(searchStatus).toHaveText("");

    // Watch panel: the same element carries each message in turn.
    await page.locator(".watch-panel-toggle").click();
    const message = page.locator(".watch-panel-message");
    await expect(message).toHaveAttribute("role", "status");
    await message.evaluate((el) => ((el as HTMLElement & { __stable?: boolean }).__stable = true));
    await page.locator(".watch-panel-search").click();
    await expect(message).toHaveText("Enter a flight number, or both From and To");
    await page.locator(".watch-panel-flight").fill("ZZ999");
    await page.locator(".watch-panel-search").click();
    await expect(message).not.toHaveText("Enter a flight number, or both From and To");
    await expect(message).not.toHaveText("Searching…");
    expect(await message.evaluate((el) => (el as HTMLElement & { __stable?: boolean }).__stable)).toBe(true);
    await expect(page.locator(".watch-panel [role=status]")).toHaveCount(1);
  });
});

test.describe("dossier focus on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("a search result lands focus on the dossier heading, Show more keeps it on the toggle, Close returns it to the search button", async ({ page }) => {
    await mockFlightApi(page);
    await page.goto("/");
    await waitForMapReady(page);

    await page.locator(".flight-search-fab").click();
    await expect(page.locator(".flight-search-panel")).toHaveClass(/control-panel--open/);
    await searchAndChoose(page);
    await expect(page.locator(".flight-search-panel")).not.toHaveClass(/control-panel--open/);
    await expect.poll(() => focused(page)).toContain("details-panel-title");

    // Show more / Show less rebuild the sheet; focus stays on the toggle.
    const toggle = page.locator(".details-panel-expand-toggle");
    await toggle.focus();
    await page.keyboard.press("Enter");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect.poll(() => focused(page)).toContain("details-panel-expand-toggle");
    await page.keyboard.press("Enter");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect.poll(() => focused(page)).toContain("details-panel-expand-toggle");

    await page.locator(".details-panel-close-x").click();
    await expect(page.locator(".details-panel")).toHaveCount(0);
    await expect.poll(() => focused(page)).toContain("flight-search-fab");
  });
});
