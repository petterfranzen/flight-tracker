import { expect, test } from "@playwright/test";
import { clickLocate, locateToastText, mapCentre, mockFlightApi, renderedUserLocation, waitForMapReady } from "./helpers";

/**
 * "Go to my location" (section9-hq#263): the control-stack button asks the
 * browser for the position, flies the map there (app zoom ~11) and marks it
 * with a GL dot — read through the adapter (renderedUserLocation/mapCentre),
 * never a DOM selector, like the plane and airport specs.
 *
 * The opening view is Stockholm, so a centre on Madrid can only come from the
 * button.
 */
test.describe.configure({ timeout: 120_000 });

const PHONE = { width: 390, height: 844 };
const MADRID = { latitude: 40.4168, longitude: -3.7038 };

test("the button centres the map on the mocked position and draws the dot", async ({ page, context }) => {
  await context.grantPermissions(["geolocation"]);
  await context.setGeolocation(MADRID);
  await page.setViewportSize(PHONE);
  await mockFlightApi(page);
  await page.goto("/");
  await waitForMapReady(page, 60_000);

  // Sanity: nothing drew a dot before the tap, and the opening view (the
  // fixed default centre) is nowhere near the mocked position.
  expect(await renderedUserLocation(page)).toBeNull();
  expect(Math.abs((await mapCentre(page)).lat - MADRID.latitude)).toBeGreaterThan(10);

  await clickLocate(page);

  // The camera lands on the position at a nearby-traffic zoom, and the dot is
  // on screen there.
  await expect.poll(async () => (await mapCentre(page)).lat, { timeout: 60_000, message: "map centred on the user" }).toBeCloseTo(MADRID.latitude, 1);
  const centre = await mapCentre(page);
  expect(centre.lon).toBeCloseTo(MADRID.longitude, 1);
  expect(centre.zoom).toBeGreaterThanOrEqual(10);
  expect(centre.zoom).toBeLessThanOrEqual(12);

  const dot = await renderedUserLocation(page);
  expect(dot, "the you-are-here dot is drawn").not.toBeNull();
  expect(dot!.lat).toBeCloseTo(MADRID.latitude, 3);
  expect(dot!.lon).toBeCloseTo(MADRID.longitude, 3);
  expect(dot!.x).toBeGreaterThan(0);
  expect(dot!.x).toBeLessThan(PHONE.width);

  // The house rules for the control itself: a 44px tap target with an
  // accessible name (it is an icon-only button on a phone).
  const button = page.locator(".map-locate-button");
  const box = (await button.boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(44);
  expect(box.height).toBeGreaterThanOrEqual(44);
  await expect(button).toHaveAttribute("aria-label", /location/i);
});

test("a denied permission shows a polite toast and nothing throws", async ({ page, context }) => {
  await context.clearPermissions();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.setViewportSize(PHONE);
  await mockFlightApi(page);
  await page.goto("/");
  await waitForMapReady(page, 60_000);

  expect(await locateToastText(page)).toBeNull();
  await clickLocate(page);

  await expect.poll(async () => locateToastText(page), { timeout: 30_000, message: "locate toast" }).toMatch(/permission/i);
  // Nothing was drawn and the map never moved, and no exception escaped.
  expect(await renderedUserLocation(page)).toBeNull();
  expect(Math.abs((await mapCentre(page)).lat - MADRID.latitude)).toBeGreaterThan(10);
  expect(errors).toEqual([]);
  // A denial is final: the control settles into a disabled error state rather
  // than prompting again.
  await expect(page.locator(".map-locate-button")).toBeDisabled();
});
