import { expect, test, type Page } from "@playwright/test";
import { findMarkerNear, getRouteVertices, LIVE_FIXTURE, mockFlightApi, setMapView, waitForMapReady, waitForPlanes } from "./helpers";

// #284: selecting a plane drew the airframe's whole 6 h track first — every
// earlier leg of it (an out-and-back, a turnaround) — and only trimmed to the
// leg it is flying when the dossier's legStartAt arrived. That is the long,
// complex trail that then snapped short. The trail now waits for the leg start
// and asks for that leg alone; with no leg start (the dossier failed, or was
// too slow to wait on), it draws the last continuous run of the reports
// instead of 6 h.

test.setTimeout(120_000);

const plane = LIVE_FIXTURE.find((p) => p.icao24 === "4d00d9")!;
const base = Date.parse(plane.observedAt);
const iso = (ms: number) => new Date(ms).toISOString();

/** A report for the selected aircraft, at an absolute position. */
function report(ms: number, latitude: number, longitude: number, onGround = false) {
  return {
    id: 1,
    icao24: plane.icao24,
    callsign: plane.callsign,
    observedAt: iso(ms),
    latitude,
    longitude,
    altitudeM: null,
    velocityMs: 100,
    headingDeg: 90,
    verticalRateMs: 0,
    onGround,
    agentSource: "opensky",
  };
}

// The airframe's earlier leg, five to six hours before its last report: south
// and west, so its points are unmistakably not the leg being flown now.
const LEG1 = [0, 1, 2, 3, 4, 5].map((i) => report(base - 6 * 60 * 60_000 + i * 10 * 60_000, 58.5 + 0.01 * i, 16.5 + 0.01 * i));
// On the ground between the two legs — an hour and ten minutes, so the reports
// before and after it are different flights whatever else says otherwise.
const GROUND = [report(base - 5 * 60 * 60_000, 59.64, 17.92, true), report(base - 70 * 60_000, 59.64, 17.92, true)];
// The leg it is flying now: the last hour, ending ten minutes before the plane.
const LEG2 = [0, 1, 2, 3, 4, 5].map((i) => report(base - 60 * 60_000 + i * 10 * 60_000, 59.2 + 0.001 * i, 17.2 + 0.001 * i));
const HISTORY = [...LEG1, ...GROUND, ...LEG2];
const LEG_START = LEG2[0].observedAt;

const key = (p: { lat?: number; lon?: number; latitude?: number; longitude?: number }) =>
  `${p.lat ?? p.latitude},${p.lon ?? p.longitude}`;
const LEG1_KEYS = LEG1.map(key);

const dossier = (legStartAt: string | null) => ({
  icao24: plane.icao24,
  registration: null,
  model: null,
  operator: null,
  originAirport: null,
  originAirportName: null,
  originAirportIata: null,
  destinationAirport: null,
  destinationAirportName: null,
  destinationAirportIata: null,
  flightMinutes: null,
  etaMinutes: null,
  cruisingAltitudeM: null,
  flightPhase: null,
  staleExplanation: null,
  legStartAt,
});

/**
 * Records, inside the page, every trail the map draws from now on: the route
 * source is read every 30 ms, so a track that is drawn and then trimmed cannot
 * slip between two round trips from the test process (which are seconds on this
 * box, and exactly how this regression hid in the first place).
 */
interface TrailWatch {
  samples: number;
  last: number;
  sawPreviousLeg: boolean;
}

async function watchTrail(page: Page, previousLeg: string[]): Promise<void> {
  await page.evaluate((keys) => {
    const win = window as unknown as { __trailWatch?: TrailWatch };
    const watch: TrailWatch = { samples: 0, last: 0, sawPreviousLeg: false };
    win.__trailWatch = watch;
    const previous = new Set(keys);
    const tick = async () => {
      const el = document.querySelector(".map-container") as unknown as { _flightMap?: FlightMapGl } | null;
      const source = el?._flightMap?.gl?.getSource("flight-route") as { getData?: () => Promise<RouteData> } | undefined;
      if (source?.getData) {
        const data = await source.getData();
        const vertices = (data.features ?? [{ geometry: data.geometry }]).flatMap((f) => f.geometry?.coordinates ?? []);
        watch.samples++;
        watch.last = vertices.length;
        if (vertices.some(([lon, lat]) => previous.has(`${lat},${lon}`))) watch.sawPreviousLeg = true;
      }
      setTimeout(tick, 30);
    };
    void tick();
  }, previousLeg);
}

interface RouteData {
  geometry?: { coordinates: [number, number][] };
  features?: { geometry?: { coordinates: [number, number][] } }[];
}
interface FlightMapGl {
  gl?: { getSource?: (id: string) => unknown };
}

const trailWatch = (page: Page) =>
  page.evaluate(() => (window as unknown as { __trailWatch?: TrailWatch }).__trailWatch ?? { samples: 0, last: 0, sawPreviousLeg: false });

/** Boots, zooms to the plane, selects it, and waits for its panel. */
async function selectPlane(page: Page): Promise<void> {
  await page.goto("/");
  await waitForMapReady(page, 30_000);
  await setMapView(page, plane.latitude, plane.longitude, 11);
  await waitForPlanes(page, 1, 30_000);
  await (await findMarkerNear(page, plane.latitude, plane.longitude)).click();
  await page.getByText("ICAO24 4D00D9").waitFor({ timeout: 5_000 });
}

test("the dossier is slower than the history: the trail never shows the previous leg", async ({ page }) => {
  await mockFlightApi(page);
  // The history answers at once; the dossier carries the leg start and takes
  // its time — the case the reported ghost trail came from.
  await page.route("**/api/flights/4d00d9/history*", (route) => route.fulfill({ json: HISTORY }));
  await page.route("**/api/aircraft/4d00d9*", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 800));
    await route.fulfill({ json: dossier(LEG_START) });
  });
  await page.goto("/");
  await waitForMapReady(page, 30_000);
  await setMapView(page, plane.latitude, plane.longitude, 11);
  await waitForPlanes(page, 1, 30_000);
  await watchTrail(page, LEG1_KEYS);
  await (await findMarkerNear(page, plane.latitude, plane.longitude)).click();

  // The current leg is drawn — and, at no point on the way there, the earlier
  // one: drawing the untrimmed history and correcting it is the bug.
  await expect.poll(async () => (await trailWatch(page)).last, { timeout: 15_000 }).toBeGreaterThan(0);
  const watch = await trailWatch(page);
  expect(watch.samples, "the watch sampled the trail while it was drawn").toBeGreaterThan(0);
  expect(watch.sawPreviousLeg, "the trail never showed the previous leg").toBe(false);

  const vertices = await getRouteVertices(page);
  expect(key(vertices[0]), "the trail starts at the current leg's takeoff").toBe(key(LEG2[0]));
  expect(vertices.some((v) => key(v) === key(LEG2[LEG2.length - 1])), "the current leg is drawn").toBe(true);
});

test("a failed dossier: the trail is the last continuous run, not 6 h", async ({ page }) => {
  await mockFlightApi(page);
  await page.route("**/api/flights/4d00d9/history*", (route) => route.fulfill({ json: HISTORY }));
  // The dossier fails: the leg start is unknown, and the trail falls back to
  // the last continuous run of the reports rather than all 6 h of them.
  await page.route("**/api/aircraft/4d00d9*", (route) => route.fulfill({ status: 500, json: null }));
  await selectPlane(page);

  await expect.poll(async () => (await getRouteVertices(page)).length, { timeout: 15_000 }).toBeGreaterThan(0);
  const vertices = await getRouteVertices(page);
  // The trail is the current leg's run: it starts at that leg's takeoff and
  // ends at the plane. The previous leg and the ground stop before it are not
  // on it — not even as a vertex of the smooth curve between reports.
  expect(key(vertices[0]), "the run starts at the current leg's takeoff").toBe(key(LEG2[0]));
  expect(key(vertices[vertices.length - 1]), "the trail ends at the plane").toBe(key(plane));
  for (const p of [...LEG1, ...GROUND]) {
    const near = vertices.some((v) => Math.abs(v.lat - p.latitude) < 1e-3 && Math.abs(v.lon - p.longitude) < 1e-3);
    expect(near, `the trail comes near ${key(p)}, which is not the leg being flown`).toBe(false);
  }
});
