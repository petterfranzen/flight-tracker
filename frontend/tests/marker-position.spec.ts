import { expect, test } from "@playwright/test";
import { findMarkerNear, getMapLatLngToContainerPoint, getRoutePathScreenPoints, HISTORIES, LIVE_FIXTURE, mockFlightApi, setMapView } from "./helpers";

// Fixture data captured from the real API (see tests/fixtures/ and the
// scripts that produced them — a straight `/live` poll and `/history`
// fetch, saved as-is). Analyzing it directly first is what ruled out the
// backend as the source of the "planes jump around" bug reports: every
// aircraft's raw history is chronologically ordered with physically
// plausible speeds throughout (checked programmatically, not eyeballed).
// So these tests assert the *frontend* renders that already-correct data
// faithfully — the two bugs found this way were both client-side races
// (stale REST responses beating fresher WebSocket ones, and a
// second-selection's history fetch resolving after a third selection's).

test.describe("aircraft marker positions", () => {
  test("renders a marker at its aircraft's true geographic position", async ({ page }) => {
    await mockFlightApi(page);
    await page.goto("/");
    await page.waitForSelector(".leaflet-container", { timeout: 10_000 });

    const target = LIVE_FIXTURE.find((p) => p.icao24 === "4aad15")!;
    await setMapView(page, target.latitude, target.longitude, 11);
    await page.waitForSelector(".plane-icon", { timeout: 10_000 });

    const expected = await getMapLatLngToContainerPoint(page, target.latitude, target.longitude);
    const marker = await findMarkerNear(page, target.latitude, target.longitude);
    const box = await marker.boundingBox();
    expect(box).not.toBeNull();
    const actual = { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };

    // A few px of slack for icon anchor rounding, not for "roughly right".
    expect(Math.abs(actual.x - expected.x)).toBeLessThan(3);
    expect(Math.abs(actual.y - expected.y)).toBeLessThan(3);
  });

  test("marker stays pinned to its true position across a pan", async ({ page }) => {
    await mockFlightApi(page);
    await page.goto("/");
    await page.waitForSelector(".leaflet-container", { timeout: 10_000 });

    const target = LIVE_FIXTURE.find((p) => p.icao24 === "4aad15")!;
    await setMapView(page, target.latitude, target.longitude, 11);
    await page.waitForSelector(".plane-icon", { timeout: 10_000 });

    // Pan away and back — the fixture /live response is identical on
    // every request, so this isolates whether *panning itself* corrupts
    // marker placement from whether stale/fresh data races do (covered by
    // the selection-race test below, which is where that bug actually was).
    await setMapView(page, target.latitude + 0.3, target.longitude + 0.3, 11);
    await page.waitForTimeout(300);
    await setMapView(page, target.latitude, target.longitude, 11);
    await page.waitForTimeout(300);

    const expected = await getMapLatLngToContainerPoint(page, target.latitude, target.longitude);
    const marker = await findMarkerNear(page, target.latitude, target.longitude);
    const box = await marker.boundingBox();
    const actual = { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
    expect(Math.abs(actual.x - expected.x)).toBeLessThan(3);
    expect(Math.abs(actual.y - expected.y)).toBeLessThan(3);
  });

  test("switching selection before the first aircraft's history loads doesn't splice the two trails together", async ({ page }) => {
    // The regression case: select aircraft A (4aad15), then — before its
    // /history response comes back — select aircraft B (4d00d9). A's
    // response is artificially delayed well past B's so it definitely
    // resolves second; before the fix, its .then() ran unconditionally and
    // stomped the trail B had already loaded.
    await mockFlightApi(page, { historyDelayMs: { "4aad15": 800, "4d00d9": 50 } });
    await page.goto("/");
    await page.waitForSelector(".leaflet-container", { timeout: 10_000 });

    const aircraftA = LIVE_FIXTURE.find((p) => p.icao24 === "4aad15")!;
    const aircraftB = LIVE_FIXTURE.find((p) => p.icao24 === "4d00d9")!;

    await setMapView(page, aircraftA.latitude, aircraftA.longitude, 11);
    await page.waitForSelector(".plane-icon", { timeout: 10_000 });
    await (await findMarkerNear(page, aircraftA.latitude, aircraftA.longitude)).click();
    await page.getByText("ICAO24 4AAD15").waitFor({ timeout: 2000 });

    // Before A's (slow) history resolves, select B — zoom out first so both
    // markers are reachable without waiting on FollowSelected's flyTo.
    await setMapView(page, (aircraftA.latitude + aircraftB.latitude) / 2, (aircraftA.longitude + aircraftB.longitude) / 2, 10);
    await page.waitForTimeout(500);

    await (await findMarkerNear(page, aircraftB.latitude, aircraftB.longitude)).click();
    await page.getByText("ICAO24 4D00D9").waitFor({ timeout: 2000 });

    // Give A's deliberately-slow response time to land and, pre-fix, corrupt things.
    await page.waitForTimeout(1000);

    // Still showing B, not reverted to A by the late response.
    await expect(page.getByText("ICAO24 4D00D9")).toBeVisible();

    const path = page.locator("path.route-line");
    await expect(path).toBeVisible();
    const points = await getRoutePathScreenPoints(page);
    const bHistory = HISTORIES["4d00d9"];
    const aHistory = HISTORIES["4aad15"];
    expect(points.length).toBeGreaterThan(0);

    // The trail's last point is always on screen (it's the aircraft's
    // current position, and the view is centered on it) — Leaflet clips a
    // Polyline's rendering to a padded viewport, so an *earlier* history
    // point can legitimately fall outside that and get dropped from the
    // rendered path entirely (this flight's real history spans hundreds of
    // km; not every point is anywhere near the current view). Asserting
    // on the first rendered point would be asserting on clipping behavior,
    // not on which aircraft's data is showing — the last point is the
    // reliable, always-on-screen check for that.
    // Slightly looser than the marker-position tests' 3px: Leaflet's
    // Polyline simplification (smoothFactor) can nudge the last rendered
    // vertex a few px from the raw point when it's part of a simplified
    // segment — real rounding, not the kind of gap a wrong-aircraft splice
    // would produce (which reads in the tens to thousands of px, as the
    // pre-fix version of this exact assertion did).
    const lastExpected = await getMapLatLngToContainerPoint(page, bHistory[bHistory.length - 1].latitude, bHistory[bHistory.length - 1].longitude);
    const last = points[points.length - 1];
    expect(Math.abs(last.x - lastExpected.x)).toBeLessThan(10);
    expect(Math.abs(last.y - lastExpected.y)).toBeLessThan(10);

    // Directly rule out contamination: none of A's history points —
    // distinctive coordinates hundreds of km from B's flight — appear
    // anywhere in the rendered path.
    for (const p of aHistory) {
      const aPoint = await getMapLatLngToContainerPoint(page, p.latitude, p.longitude);
      for (const rendered of points) {
        const dist = Math.hypot(rendered.x - aPoint.x, rendered.y - aPoint.y);
        expect(dist).toBeGreaterThan(10);
      }
    }
  });
});
