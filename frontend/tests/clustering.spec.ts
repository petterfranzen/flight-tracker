import { expect, test } from "@playwright/test";
import { mockFlightApi, setMapView, withMap } from "./helpers";

// CLUSTER_FETCH_MAX_ZOOM (FlightMap.tsx) — kept in sync manually, same as
// marker-position.spec.ts's own zoom literals; there's no shared constant
// to import across the test/app boundary.
const BELOW_CLUSTER_THRESHOLD_ZOOM = 3;

test.describe("clustering", () => {
  test("zooming out past the cluster threshold shows aggregated bubbles, not individual markers", async ({ page }) => {
    await mockFlightApi(page, { clusters: [{ lat: 20, lon: 10, count: 42 }] });
    await page.goto("/");
    await page.waitForSelector(".leaflet-container", { timeout: 10_000 });

    await setMapView(page, 20, 10, BELOW_CLUSTER_THRESHOLD_ZOOM);
    await page.waitForSelector(".cluster-icon", { timeout: 10_000 });

    // No exact count on the mark anymore (see clusterIcon/clusterPlaneCount
    // in FlightMap.tsx) — just a coarse read of "how much traffic" via how
    // many overlapping plane glyphs it shows. count: 42 falls in the
    // 10-49 bucket, i.e. 3 planes.
    const mark = page.locator(".cluster-icon-mark");
    await expect(mark).toHaveClass(/cluster-icon-mark--3/);
    await expect(mark.locator("svg")).toHaveCount(3);
    await expect(page.locator(".cluster-icon-count")).toHaveCount(0);
  });

  test("clicking a cluster bubble zooms in", async ({ page }) => {
    await mockFlightApi(page, { clusters: [{ lat: 20, lon: 10, count: 42 }] });
    await page.goto("/");
    await page.waitForSelector(".leaflet-container", { timeout: 10_000 });

    await setMapView(page, 20, 10, BELOW_CLUSTER_THRESHOLD_ZOOM);
    await page.waitForSelector(".cluster-icon", { timeout: 10_000 });

    await page.locator(".cluster-icon-mark").click();
    await page.waitForTimeout(200);

    const zoom = await withMap(page, (map) => map.getZoom());
    expect(zoom).toBeGreaterThan(BELOW_CLUSTER_THRESHOLD_ZOOM);
  });
});
