import { expect, test, type Page } from "@playwright/test";
import { LIVE_FIXTURE, freezeClock, mockFlightApi, seedWatched, waitForMapReady } from "./helpers";

// The browser-only notification slice (#82 design, first slice): the bell's
// permission states, the consent copy, and the two-tick take-off/landing rules
// driven from the same background poll. Notification is stubbed; the clock is
// frozen, so every timer and poll is deterministic.

// Map + software WebGL on a 0.4-CPU sandbox: 60 s is tight when the box is
// loaded. Still state-driven; this only widens the budget.
test.setTimeout(120_000);

const plane = LIVE_FIXTURE.find((p) => p.callsign === "SAS2112")!;
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
  icao24: plane.icao24,
  airborne,
});
// The 72 h prune keys off the flight date; use today's Swedish date so the
// test's own notification state survives long enough to assert against.
const TODAY = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Stockholm" });
const WATCHED = [{ flightNumber: "SK2112", date: TODAY, airport: "ARN", label: "LHR → ARN" }];
const NOTIFY_KEY = `SK2112|${TODAY}|ARN`;

/** Replaces Notification and the service-worker registration with recording stubs. */
async function stubNotifications(page: Page, opts: { permission: "default" | "granted" | "denied"; grant?: boolean }): Promise<void> {
  await page.addInitScript(({ permission, grant }) => {
    const calls: unknown[] = [];
    (window as any).__notifyCalls = calls;
    (window as any).__permissionRequests = 0;
    let currentPermission = permission;
    class FakeNotification {
      static get permission(): string {
        return currentPermission;
      }
      static async requestPermission(): Promise<string> {
        (window as any).__permissionRequests++;
        if (grant) currentPermission = "granted";
        return currentPermission;
      }
      constructor(title: string, options: unknown) {
        calls.push({ title, options });
      }
    }
    Object.defineProperty(window, "Notification", { configurable: true, writable: true, value: FakeNotification });
    const registration = {
      showNotification: async (title: string, options: unknown) => {
        calls.push({ title, options });
      },
    };
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: { ready: Promise.resolve(registration), register: async () => registration },
    });
  }, opts);
}

/** Seeds the per-flight notification state as the bell would have left it. */
async function seedNotify(page: Page, enabled: boolean): Promise<void> {
  await page.addInitScript(({ key, enabled }) => {
    // Seed once. An init script runs on every navigation, so seeding blindly
    // would erase the very state a reload is meant to read back — and a reload
    // assertion could then never see a repeat even if dedup were broken.
    if (sessionStorage.getItem("__ft_notify_seeded")) return;
    sessionStorage.setItem("__ft_notify_seeded", "1");
    localStorage.setItem(
      "flighttracker:watchNotify",
      JSON.stringify({
        [key]: {
          enabled,
          icao24: null,
          airborne: null,
          everAirborne: false,
          airborneStreak: 0,
          edgeFromGround: false,
          onGroundStreak: 0,
          lastEventKeys: [],
          sentAt: [],
        },
      }),
    );
  }, { key: NOTIFY_KEY, enabled });
}

async function openPanel(page: Page): Promise<void> {
  await page.locator(".watch-panel-toggle").click();
  await expect(page.locator(".watch-panel-item").first()).toBeVisible();
}

test("permission default: the prompt fires only on the Notify me click, then the flight is on", async ({ page }) => {
  await stubNotifications(page, { permission: "default", grant: true });
  await mockFlightApi(page);
  await page.route("**/api/schedule/search*", (route) => route.fulfill({ json: [row(false)] }));
  await seedWatched(page, WATCHED);
  await page.goto("/");
  await waitForMapReady(page, 20_000);
  await openPanel(page);

  // Nothing has asked yet — not on load, not when the bell opens the block.
  expect(await page.evaluate(() => (window as any).__permissionRequests)).toBe(0);
  await page.locator(".watch-panel-bell").click();
  const block = page.locator(".watch-panel-notify");
  await expect(block).toContainText("Notifications appear while this site is open");
  await expect(block).toContainText("a closed browser is not");
  expect(await page.evaluate(() => (window as any).__permissionRequests)).toBe(0);

  await block.getByRole("button", { name: "Notify me" }).click();
  await expect(block).toContainText("Notifications: on");
  expect(await page.evaluate(() => (window as any).__permissionRequests)).toBe(1);
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("flighttracker:watchNotify")!));
  expect(stored[NOTIFY_KEY].enabled).toBe(true);

  // The granted path proves the OS chain without waiting for a flight event.
  await block.getByRole("button", { name: "Send a test notification" }).click();
  await expect.poll(async () => page.evaluate(() => ((window as any).__notifyCalls as unknown[]).length)).toBeGreaterThan(0);
});

test("permission granted: the bell opts the flight in without another prompt", async ({ page }) => {
  await stubNotifications(page, { permission: "granted" });
  await mockFlightApi(page);
  await page.route("**/api/schedule/search*", (route) => route.fulfill({ json: [row(false)] }));
  await seedWatched(page, WATCHED);
  await page.goto("/");
  await waitForMapReady(page, 20_000);
  await openPanel(page);

  await page.locator(".watch-panel-bell").click();
  const block = page.locator(".watch-panel-notify");
  await expect(block).toContainText("Notifications: not enabled for this flight");
  await block.getByRole("button", { name: "Notify me" }).click();
  await expect(block).toContainText("Notifications: on");
  expect(await page.evaluate(() => (window as any).__permissionRequests)).toBe(0);
});

test("permission denied: the block says so and never pretends otherwise", async ({ page }) => {
  await stubNotifications(page, { permission: "denied" });
  await mockFlightApi(page);
  await page.route("**/api/schedule/search*", (route) => route.fulfill({ json: [row(false)] }));
  await seedWatched(page, WATCHED);
  await page.goto("/");
  await waitForMapReady(page, 20_000);
  await openPanel(page);

  await page.locator(".watch-panel-bell").click();
  const block = page.locator(".watch-panel-notify");
  await expect(block).toContainText("Notifications: blocked in your browser");
  await expect(block).toContainText("the in-app banner still works");
  await expect(block.getByRole("button", { name: "Notify me" })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__permissionRequests)).toBe(0);
});

test("permission default stays default: no enable, no false 'on'", async ({ page }) => {
  await stubNotifications(page, { permission: "default", grant: false });
  await mockFlightApi(page);
  await page.route("**/api/schedule/search*", (route) => route.fulfill({ json: [row(false)] }));
  await seedWatched(page, WATCHED);
  await page.goto("/");
  await waitForMapReady(page, 20_000);
  await openPanel(page);

  await page.locator(".watch-panel-bell").click();
  const block = page.locator(".watch-panel-notify");
  await block.getByRole("button", { name: "Notify me" }).click();
  await expect(block).toContainText("Notifications: not enabled for this flight");
  expect(await page.evaluate(() => (window as any).__permissionRequests)).toBe(1);
  const stored = await page.evaluate(() => {
    const raw = localStorage.getItem("flighttracker:watchNotify");
    return raw ? JSON.parse(raw) : {};
  });
  expect(stored[NOTIFY_KEY]?.enabled ?? false).toBe(false);
});

test("take-off announces only on the second consecutive airborne poll", async ({ page }) => {
  await stubNotifications(page, { permission: "granted" });
  await freezeClock(page);
  await mockFlightApi(page);
  let airborne = false;
  let schedulePolls = 0;
  await page.route("**/api/schedule/search*", (route) => {
    schedulePolls++;
    return route.fulfill({ json: [row(airborne)] });
  });
  await seedWatched(page, WATCHED);
  await seedNotify(page, true);
  await page.goto("/");
  await waitForMapReady(page, 20_000);
  await expect.poll(() => schedulePolls).toBeGreaterThan(0);

  // The boot poll saw it on the ground: no banner.
  await expect(page.locator(".watch-toast")).toBeHidden();

  airborne = true;
  await page.clock.runFor(61_000); // first airborne tick
  await expect.poll(async () => {
    const raw = await page.evaluate(() => localStorage.getItem("flighttracker:watchNotify"));
    return raw ? JSON.parse(raw)[NOTIFY_KEY]?.airborne : null;
  }).toBe(true);
  await expect(page.locator(".watch-toast")).toBeHidden();

  await page.clock.runFor(61_000); // second tick confirms the edge
  const toast = page.locator(".watch-toast");
  await expect(toast).toBeVisible();
  await expect(toast).toContainText("SK2112 LHR → ARN is airborne.");
});

test("landing announces once and a reload never repeats it", async ({ page }) => {
  await stubNotifications(page, { permission: "granted" });
  await freezeClock(page);
  await mockFlightApi(page);
  let airborne = true;
  let onGround = false;
  let schedulePolls = 0;
  await page.route("**/api/schedule/search*", (route) => {
    schedulePolls++;
    return route.fulfill({ json: [row(airborne)] });
  });
  await page.route(`**/api/flights/${plane.icao24}/live*`, (route) => route.fulfill({ json: { ...plane, onGround } }));
  await seedWatched(page, WATCHED);
  await seedNotify(page, true);
  await page.goto("/");
  await waitForMapReady(page, 20_000);
  await expect.poll(() => schedulePolls).toBeGreaterThan(0);

  // First seen already airborne: no take-off announcement.
  await expect(page.locator(".watch-toast")).toBeHidden();

  airborne = false;
  onGround = true;
  await page.clock.runFor(61_000); // first on-ground tick
  await expect.poll(async () => {
    const raw = await page.evaluate(() => localStorage.getItem("flighttracker:watchNotify"));
    return raw ? JSON.parse(raw)[NOTIFY_KEY]?.onGroundStreak : 0;
  }).toBeGreaterThan(0);
  await expect(page.locator(".watch-toast")).toBeHidden();
  await page.clock.runFor(61_000); // second tick -> landed
  await expect(page.locator(".watch-toast")).toContainText("SK2112 landed at ARN");

  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("flighttracker:watchNotify")!));
  expect(stored[NOTIFY_KEY].lastEventKeys).toContain("landed");

  // Reload: the same on-ground row must not announce the landing again. The
  // state has to survive the reload for this to prove anything (the seed is
  // one-shot for exactly this reason), and two ticks are enough for a fresh
  // detection — so a silent banner here is real dedup, not an empty state.
  await page.reload();
  await waitForMapReady(page, 20_000);
  const afterReload = await page.evaluate(() => JSON.parse(localStorage.getItem("flighttracker:watchNotify")!));
  expect(afterReload[NOTIFY_KEY].lastEventKeys).toContain("landed");
  expect(afterReload[NOTIFY_KEY].everAirborne).toBe(true);
  await page.clock.runFor(61_000);
  await page.clock.runFor(61_000);
  await expect(page.locator(".watch-toast")).toBeHidden();
});

test("a flight that landed while the page was closed announces landed once after the reload", async ({ page }) => {
  await stubNotifications(page, { permission: "granted" });
  await freezeClock(page);
  await mockFlightApi(page);
  let airborne = true;
  let onGround = false;
  let schedulePolls = 0;
  await page.route("**/api/schedule/search*", (route) => {
    schedulePolls++;
    return route.fulfill({ json: [row(airborne)] });
  });
  await page.route(`**/api/flights/${plane.icao24}/live*`, (route) => route.fulfill({ json: { ...plane, onGround } }));
  await seedWatched(page, WATCHED);
  await seedNotify(page, true);
  await page.goto("/");
  await waitForMapReady(page, 20_000);
  await expect.poll(() => schedulePolls).toBeGreaterThan(0);
  // Seen already airborne: no take-off to announce.
  await expect(page.locator(".watch-toast")).toBeHidden();

  // The page closes while the flight is in the air; it lands meanwhile.
  airborne = false;
  onGround = true;
  await page.reload();
  await waitForMapReady(page, 20_000);
  await page.clock.runFor(61_000);
  await page.clock.runFor(61_000);
  const toast = page.locator(".watch-toast");
  await expect(toast).toContainText("SK2112 landed at ARN");
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("flighttracker:watchNotify")!));
  expect(stored[NOTIFY_KEY].everAirborne).toBe(true);
  expect(stored[NOTIFY_KEY].lastEventKeys).toContain("landed");

  // And only once: another reload reads the persisted landing, not a new one.
  await page.reload();
  await waitForMapReady(page, 20_000);
  await page.clock.runFor(61_000);
  await page.clock.runFor(61_000);
  await expect(page.locator(".watch-toast")).toBeHidden();
});
