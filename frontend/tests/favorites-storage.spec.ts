import { expect, test } from "@playwright/test";
import { LIVE_FIXTURE, mockFlightApi, waitForMapReady } from "./helpers";
import {
  cookieNameFor,
  encodedLength,
  fitToBudget,
  loadList,
  parseList,
  saveList,
  VALUE_BUDGET_BYTES,
} from "../src/persist";
import type { FavoriteAircraft } from "../src/favorites";

// Favorites and watched flights live in localStorage *and* a same-origin
// cookie (see src/persist.ts): the cookie is the copy that survives what
// localStorage doesn't. The pure/stubbed checks below run without a page and
// cover the store-selection logic directly; the browser tests drive it the
// way a user does.

const KEY = "flighttracker:favoriteAircraft";
const COOKIE = cookieNameFor(KEY);
const WATCHED_KEY = "flighttracker:watchedFlights";

const oneFav: FavoriteAircraft[] = [{ icao24: "4aad15", registration: "SE-ABC", callsign: "SAS123" }];

/** Reads a cookie's decoded value in the page (or null). */
function cookieValue(page: import("@playwright/test").Page, name: string): Promise<string | null> {
  return page.evaluate((n) => {
    const prefix = `${n}=`;
    for (const part of document.cookie.split("; ")) {
      if (part.startsWith(prefix)) return decodeURIComponent(part.slice(prefix.length));
    }
    return null;
  }, name);
}

// --- the store logic, against a stubbed localStorage/document ---

/** A minimal cookie jar + localStorage, installed as Node globals for the tests that follow. */
function installFakeDom() {
  const cookies = new Map<string, string>();
  const storage = new Map<string, string>();
  const cookieWrites: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any;
  g.document = {
    get cookie() {
      return [...cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    },
    set cookie(raw: string) {
      cookieWrites.push(raw);
      const [pair, ...attrs] = raw.split("; ");
      const name = pair.slice(0, pair.indexOf("="));
      const value = pair.slice(pair.indexOf("=") + 1);
      const maxAge = attrs.find((a) => a.toLowerCase().startsWith("max-age="));
      if (maxAge && Number(maxAge.split("=")[1]) <= 0) cookies.delete(name);
      else cookies.set(name, value);
    },
  };
  g.localStorage = {
    getItem: (k: string) => (storage.has(k) ? storage.get(k)! : null),
    setItem: (k: string, v: string) => void storage.set(k, String(v)),
    removeItem: (k: string) => void storage.delete(k),
    clear: () => storage.clear(),
  };
  const restore = () => {
    delete g.document;
    delete g.localStorage;
  };
  return { cookies, storage, cookieWrites, restore };
}

test.describe("persist (stubbed storage)", () => {
  let dom: ReturnType<typeof installFakeDom>;
  test.beforeEach(() => {
    dom = installFakeDom();
  });
  test.afterEach(() => dom.restore());

  test("save writes localStorage whole and the cookie compact, with the right attributes", () => {
    const g = globalThis as unknown as { location?: unknown };
    g.location = { protocol: "https:" };
    saveList(KEY, [{ icao24: "abcdef", registration: null, callsign: "BA1" }]);
    delete g.location;

    expect(JSON.parse(dom.storage.get(KEY)!)).toEqual([{ icao24: "abcdef", registration: null, callsign: "BA1" }]);
    // Compact: the null registration is dropped from the cookie only.
    // (The jar stores the value encoded, as a browser would.)
    expect(parseList(decodeURIComponent(dom.cookies.get(COOKIE)!))).toEqual([{ icao24: "abcdef", callsign: "BA1" }]);
    const raw = dom.cookieWrites.at(-1)!;
    expect(raw).toContain(`${COOKIE}=`);
    expect(raw).toContain("Path=/");
    expect(raw).toContain("SameSite=Lax");
    expect(raw).toContain("Secure"); // https
    expect(raw).toContain(`Max-Age=${400 * 24 * 60 * 60}`);
  });

  test("no Secure attribute over plain http", () => {
    saveList(KEY, oneFav);
    expect(dom.cookieWrites.at(-1)!).not.toContain("Secure");
  });

  test("load reads localStorage first and re-seeds a missing cookie", () => {
    dom.storage.set(KEY, JSON.stringify(oneFav));
    expect(loadList<FavoriteAircraft>(KEY)).toEqual(oneFav);
    expect(dom.cookies.has(COOKIE)).toBe(true);
  });

  test("load falls back to the cookie when localStorage is empty, and re-seeds localStorage", () => {
    dom.cookies.set(COOKIE, encodeURIComponent(JSON.stringify(oneFav)));
    expect(loadList<FavoriteAircraft>(KEY)).toEqual(oneFav);
    expect(JSON.parse(dom.storage.get(KEY)!)).toEqual(oneFav);
  });

  test("a corrupt cookie is ignored (and neither store is written)", () => {
    dom.cookies.set(COOKIE, encodeURIComponent("{not json"));
    expect(loadList<FavoriteAircraft>(KEY)).toEqual([]);
    expect(dom.storage.has(KEY)).toBe(false);
  });

  test("an empty stored list is trusted and not resurrected from a stale cookie", () => {
    dom.storage.set(KEY, "[]");
    dom.cookies.set(COOKIE, encodeURIComponent(JSON.stringify(oneFav)));
    expect(loadList<FavoriteAircraft>(KEY)).toEqual([]);
  });

  test("an over-limit list is trimmed in the cookie only, keeping the newest", () => {
    const big: FavoriteAircraft[] = Array.from({ length: 300 }, (_, i) => ({
      icao24: i.toString(16).padStart(6, "0"),
      registration: `REG${i}`,
      callsign: `FLT${i}`,
    }));
    saveList(KEY, big);
    const cookie = dom.cookies.get(COOKIE)!; // stored encoded, as a browser would
    expect(cookie.length).toBeLessThanOrEqual(VALUE_BUDGET_BYTES);
    const trimmed = parseList<FavoriteAircraft>(decodeURIComponent(cookie))!;
    expect(trimmed.length).toBeGreaterThan(0);
    expect(trimmed.length).toBeLessThan(big.length);
    expect(trimmed.at(-1)).toEqual(big.at(-1)); // newest kept, oldest dropped
    expect(JSON.parse(dom.storage.get(KEY)!)).toHaveLength(big.length); // localStorage keeps everything
  });
});

test.describe("persist helpers (pure)", () => {
  test("fitToBudget drops the oldest entries until the cookie value fits, keeping a suffix", () => {
    const list: FavoriteAircraft[] = Array.from({ length: 300 }, (_, i) => ({
      icao24: i.toString(16).padStart(6, "0"),
      registration: `REG${i}`,
      callsign: `FLT${i}`,
    }));
    const fitted = fitToBudget(list);
    expect(fitted.length).toBeGreaterThan(0);
    expect(fitted.length).toBeLessThan(list.length);
    expect(fitted).toEqual(list.slice(list.length - fitted.length)); // oldest (front) dropped
    expect(encodedLength(JSON.stringify(fitted))).toBeLessThanOrEqual(VALUE_BUDGET_BYTES);
  });

  test("a single entry too big to fit trims to empty rather than an oversized cookie", () => {
    expect(fitToBudget([{ blob: "x".repeat(VALUE_BUDGET_BYTES) }])).toEqual([]);
    expect(fitToBudget([])).toEqual([]);
  });

  test("parseList ignores corrupt, empty and non-array JSON", () => {
    expect(parseList("{not json")).toBeNull();
    expect(parseList('{"a":1}')).toBeNull();
    expect(parseList(null)).toBeNull();
    expect(parseList("")).toBeNull();
    expect(parseList("[]")).toEqual([]);
  });

  test("cookieNameFor flattens keys into a valid cookie name", () => {
    expect(cookieNameFor("flighttracker:favoriteRoutes")).toBe("ft_flighttracker_favoriteRoutes");
  });
});

// --- the same behaviour through the browser ---

/** Search for the callsign, select the result, and favorite the aircraft in its details panel. */
async function addFavoriteThroughUi(page: import("@playwright/test").Page): Promise<FavoriteAircraft> {
  const target = LIVE_FIXTURE.find((p) => p.icao24 === "4aad15")!;
  await page.locator(".flight-search-input").first().fill(target.callsign!);
  const option = page.locator(".flight-search-option", { hasText: target.callsign! });
  await option.waitFor({ timeout: 5_000 });
  await option.click();
  await page.getByText(`ICAO24 ${target.icao24.toUpperCase()}`).waitFor({ timeout: 5_000 });
  await page.getByRole("button", { name: "Favorite this aircraft", exact: true }).click();
  return { icao24: target.icao24, callsign: target.callsign! };
}

test.describe("favorites storage (browser)", () => {
  // Each test boots the map (and most reload it); give the slow ones room.
  test.describe.configure({ timeout: 60_000 });

  test("favoriting an aircraft writes both stores", async ({ page }) => {
    await mockFlightApi(page);
    await page.goto("/");
    await waitForMapReady(page);

    const fav = await addFavoriteThroughUi(page);

    // registration is null (the mock's /api/aircraft/* is a 404), so the
    // compact cookie writer drops it; localStorage keeps it.
    expect(parseList<FavoriteAircraft>(await cookieValue(page, COOKIE))).toEqual([{ icao24: fav.icao24, callsign: fav.callsign }]);
    expect(parseList<FavoriteAircraft>(await page.evaluate((k) => localStorage.getItem(k), KEY))).toEqual([
      { icao24: fav.icao24, registration: null, callsign: fav.callsign },
    ]);
    await expect(page.locator(".favorites-panel-toggle")).toHaveText("★ Favorites (1) ▼");
  });

  test("a favourite survives localStorage being cleared, restored from the cookie", async ({ page }) => {
    await mockFlightApi(page);
    await page.goto("/");
    await waitForMapReady(page);
    await addFavoriteThroughUi(page);

    // localStorage gone (private browsing, quota, Safari's 7-day sweep): the cookie still has it.
    await page.evaluate((k) => localStorage.removeItem(k), KEY);
    await page.reload();
    await waitForMapReady(page);

    await expect(page.locator(".favorites-panel-toggle")).toHaveText("★ Favorites (1) ▼");
    // ...and localStorage was re-seeded from the cookie.
    expect(parseList<FavoriteAircraft>(await page.evaluate((k) => localStorage.getItem(k), KEY))).toHaveLength(1);
  });

  test("a cleared cookie is re-seeded from localStorage on load", async ({ page }) => {
    await mockFlightApi(page);
    await page.goto("/");
    await waitForMapReady(page);

    await page.evaluate(([k, v]) => localStorage.setItem(k, JSON.stringify(v)), [KEY, oneFav] as const);
    await page.reload();
    await waitForMapReady(page);
    expect(parseList<FavoriteAircraft>(await cookieValue(page, COOKIE))).toHaveLength(1);

    // Drop the cookie only; localStorage still holds it (the reverse of the test above).
    await page.evaluate((n) => {
      document.cookie = `${n}=; Path=/; Max-Age=0`;
    }, COOKIE);
    await page.reload();
    await waitForMapReady(page);

    expect(parseList<FavoriteAircraft>(await cookieValue(page, COOKIE))).toHaveLength(1);
    await expect(page.locator(".favorites-panel-toggle")).toHaveText("★ Favorites (1) ▼");
  });

  test("a corrupt cookie is ignored and the app still boots", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));

    await mockFlightApi(page);
    await page.goto("/");
    await waitForMapReady(page);

    await page.evaluate((n) => {
      localStorage.removeItem("flighttracker:favoriteAircraft");
      document.cookie = `${n}=${encodeURIComponent("{not json")}; Path=/; Max-Age=3600`;
    }, COOKIE);
    await page.reload();
    await waitForMapReady(page);

    await expect(page.locator(".favorites-panel-toggle")).toHaveText("★ Favorites ▼");
    expect(errors).toEqual([]);
  });

  test("an over-limit list is trimmed for the cookie without breaking the app", async ({ page }) => {
    const big: FavoriteAircraft[] = Array.from({ length: 300 }, (_, i) => ({
      icao24: i.toString(16).padStart(6, "0"),
      registration: `REG${i}`,
      callsign: `FLT${i}`,
    }));
    const expected = fitToBudget(big);

    await mockFlightApi(page);
    await page.goto("/");
    await waitForMapReady(page);

    // Seeded past the cookie budget; the boot write must trim it.
    await page.evaluate(([k, v]) => localStorage.setItem(k, JSON.stringify(v)), [KEY, big] as const);
    await page.reload();
    await waitForMapReady(page);

    const raw = await cookieValue(page, COOKIE);
    expect(raw).not.toBeNull();
    expect(encodedLength(raw!)).toBeLessThanOrEqual(VALUE_BUDGET_BYTES);
    expect(parseList<FavoriteAircraft>(raw)).toHaveLength(expected.length);

    // localStorage cleared later (Safari): the app restores the trimmed list, uncrashed.
    await page.evaluate((k) => localStorage.removeItem(k), KEY);
    await page.reload();
    await waitForMapReady(page);
    await expect(page.locator(".favorites-panel-toggle")).toHaveText(`★ Favorites (${expected.length}) ▼`);
  });

  test("watched flights are stored in the cookie too", async ({ page }) => {
    const watchedCookie = cookieNameFor(WATCHED_KEY);
    await mockFlightApi(page);
    await page.goto("/");
    await waitForMapReady(page);

    await page.evaluate(
      ([k, v]) => localStorage.setItem(k, JSON.stringify(v)),
      [WATCHED_KEY, [{ flightNumber: "BA778", date: "2026-11-05", airport: "ARN", label: "LHR → ARN" }]] as const,
    );
    await page.reload();
    await waitForMapReady(page);

    expect(parseList(await cookieValue(page, watchedCookie))).toHaveLength(1);
  });
});
