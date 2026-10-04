import { expect, test } from "@playwright/test";
import { mockFlightApi, setMapView, withMap } from "./helpers";

// Planes get bigger as you zoom in, and a plane with open space around it
// gets an invisible click margin (`plane-icon--roomy`); crowded planes keep
// their plain box so a margin never steals a neighbour's click.

const base = { callsign: null, observedAt: new Date().toISOString(), altitudeM: 9000, velocityMs: 200, headingDeg: 90, verticalRateMs: 0, onGround: false, agentSource: "opensky" };
const plane = (n: number, icao24: string, lat: number, lon: number) => ({ ...base, id: n, icao24, callsign: icao24.toUpperCase(), latitude: lat, longitude: lon });

// Planes are placed by screen offset from the view centre (px), so the spacing
// holds whatever the zoom's metres-per-pixel.
async function serve(page: import("@playwright/test").Page, offsets: [string, number, number][]) {
  await mockFlightApi(page);
  await page.goto("/");
  await page.waitForSelector(".leaflet-container", { timeout: 10_000 });
  await setMapView(page, 59.3, 18.0, 13);
  const planes = await withMap(
    page,
    (map, offs: [string, number, number][]) => {
      const c = map.latLngToContainerPoint([59.3, 18.0]);
      return offs.map(([id, dx, dy]) => {
        const ll = map.containerPointToLatLng([c.x + dx, c.y + dy]);
        return { id, lat: ll.lat, lon: ll.lng };
      });
    },
    offsets,
  );
  const body = planes.map((p, i) => plane(i + 1, p.id, p.lat, p.lon));
  await page.route("**/api/flights/live*", (route) => (route.request().url().includes("/count") ? route.fallback() : route.fulfill({ json: body })));
  await setMapView(page, 59.3, 18.0, 13); // refetch under the new route
  await page.waitForSelector(".plane-icon:not(.plane-icon--exiting)", { timeout: 10_000 });
  await page.waitForTimeout(600);
}

test("a lone plane has a click margin; crowded planes do not", async ({ page }) => {
  await serve(page, [
    ["aaaaaa", -200, 0], // alone
    ["bbbbbb", 100, 0], // two planes 40px apart: too close for margins
    ["cccccc", 140, 0],
  ]);
  const roomyCount = await page.locator(".plane-icon--roomy").count();
  expect(roomyCount).toBe(1);
  const lone = page.locator(".plane-icon--roomy");
  const box = (await lone.boundingBox())!;
  // Click well outside the glyph box but inside the margin (box edge + 8px).
  await page.mouse.click(box.x + box.width + 8, box.y + box.height / 2);
  await expect(page.getByText("ICAO24 AAAAAA")).toBeVisible({ timeout: 5_000 });
});

test("icons grow as you zoom in past full size", async ({ page }) => {
  await serve(page, [["aaaaaa", 0, 0]]);
  const size = async () => (await page.locator(".plane-icon").first().boundingBox())!.width;
  await setMapView(page, 59.3, 18.0, 10);
  await page.waitForTimeout(300);
  const at10 = await size();
  await setMapView(page, 59.3, 18.0, 14);
  await page.waitForTimeout(300);
  const at14 = await size();
  expect(at14).toBeGreaterThan(at10 * 1.3);
});
