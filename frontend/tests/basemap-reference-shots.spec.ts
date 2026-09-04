import { test } from "@playwright/test";
import { mockFlightApi, setMapView } from "./helpers";

/**
 * Not an assertion test — captures the cyberpunk basemap at a spread of
 * zooms so the style can be eyeballed after a change. Kept because
 * cyberpunkMapStyle.ts is tuned by looking at it, and "did the graticule
 * survive / did the roads get heavy again" is not something a DOM
 * assertion can answer.
 */
const VIEWS = [
  { name: "1-wide-z5", lat: 59.0, lon: 15.0, zoom: 5 },
  { name: "2-regional-z9", lat: 59.65, lon: 17.92, zoom: 9 },
  { name: "3-airport-z12", lat: 59.6519, lon: 17.9186, zoom: 12 },
  { name: "4-gates-z15", lat: 59.6519, lon: 17.9186, zoom: 15 },
];

test("cyberpunk basemap reference shots", async ({ page }) => {
  test.setTimeout(180_000);
  await mockFlightApi(page);
  await page.addInitScript(() => localStorage.setItem("flighttracker:theme", "cyberpunk"));
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  await page.waitForSelector(".leaflet-container");
  await page.waitForTimeout(6000);

  for (const v of VIEWS) {
    await setMapView(page, v.lat, v.lon, v.zoom);
    await page.waitForTimeout(7000);
    await page.screenshot({ path: `spike-shots/${v.name}.png` });
  }
});
