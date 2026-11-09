import { expect, test } from "@playwright/test";
import { LIVE_FIXTURE, freezeClock, mockFlightApi, setMapView, waitForMapReady, waitForPlanes } from "./helpers";

// subscribeLiveFeed (src/api/flightApi.ts): what the browser client does
// when /ws/live keeps dropping it.

test.describe("live feed reconnect", () => {
  test("backs off exponentially on repeated drops and never calls /api/agents/restart from a reconnect", async ({ page }) => {
    await mockFlightApi(page);
    const restarts: number[] = [];
    await page.route("**/api/agents/restart", (route) => {
      restarts.push(Date.now());
      return route.fulfill({ json: { active: true, secondsRemaining: 300 } });
    });
    const connects: { at: number; url: string }[] = [];
    // Accept the upgrade, then drop it straight away the way a server does
    // when it gives up on a client (1011) — over and over.
    await page.routeWebSocket("**/ws/live", (ws) => {
      connects.push({ at: Date.now(), url: ws.url() });
      setTimeout(() => ws.close({ code: 1011, reason: "test drop" }), 20);
    });

    await page.goto("/");
    await page.waitForTimeout(8_000);

    expect(connects.length).toBeGreaterThanOrEqual(3);
    expect(connects.length).toBeLessThanOrEqual(5); // 1s, 2s, 4s (±25%) — not a 1s storm
    const gaps = connects.slice(1).map((c, i) => c.at - connects[i].at);
    // The k-th retry waits 1s * 2^k, jittered ±25%, so each gap is at least
    // 0.75 * 2^k s. A busy main thread (the map booting in software WebGL)
    // only ever makes a timer late, so lower bounds hold where comparing one
    // gap with the next did not: a late first retry outgrew an early second.
    gaps.forEach((gap, k) => expect(gap, `gap ${k + 1}`).toBeGreaterThanOrEqual(750 * 2 ** k));

    const origin = new URL(page.url());
    expect(connects[0].url).toBe(`ws://${origin.host}/ws/live`);
    // Page load with the poll window closed (mockFlightApi's status says
    // inactive) is the one allowed caller here — once, not per reconnect.
    expect(restarts).toHaveLength(1);
  });

  // Over the per-IP cap the server completes the upgrade and then closes with
  // 1013 ("try again later"), not an HTTP 429 (section9-hq #168). 1013 is not
  // a fatal code, so the client retries, but it must back off while it does.
  test("backs off, capped and without error spam, when the server closes 1013 over the per-IP cap", async ({ page }) => {
    await mockFlightApi(page);
    let accepted = 0;
    await page.routeWebSocket("**/ws/live", (ws) => {
      accepted++;
      ws.close({ code: 1013, reason: "try again later" });
    });
    // The page's own view of each attempt, stamped by its (frozen) clock, so
    // the delays are exact and a busy machine cannot stretch them. A handler
    // is added at construction, so it runs before the app's own onclose.
    await page.addInitScript(() => {
      const log = { connects: [] as number[], closes: [] as { at: number; code: number }[] };
      (window as unknown as { __live: typeof log }).__live = log;
      const Native = window.WebSocket;
      const Wrapped = function (this: unknown, url: string | URL, protocols?: string | string[]) {
        const ws = protocols === undefined ? new Native(url) : new Native(url, protocols);
        if (String(url).includes("/ws/live")) {
          log.connects.push(Date.now());
          ws.addEventListener("close", (e) => log.closes.push({ at: Date.now(), code: e.code }));
        }
        return ws;
      } as unknown as typeof WebSocket;
      Wrapped.prototype = Native.prototype;
      Object.assign(Wrapped, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
      window.WebSocket = Wrapped;
    });
    const pageErrors: string[] = [];
    const liveFeedLogs: string[] = []; // other console noise (blocked fonts, GL driver notes) is not ours
    page.on("pageerror", (e) => pageErrors.push(e.message));
    page.on("console", (m) => {
      if ((m.type() === "error" || m.type() === "warning") && /live feed|websocket|ws\/live|1013/i.test(m.text())) liveFeedLogs.push(m.text());
    });
    const restarts: number[] = [];
    await page.route("**/api/agents/restart", (route) => {
      restarts.push(Date.now());
      return route.fulfill({ json: { active: true, secondsRemaining: 300 } });
    });

    await freezeClock(page);
    await page.goto("/");
    await waitForMapReady(page);

    const live = () =>
      page.evaluate(() => (window as unknown as { __live: { connects: number[]; closes: { at: number; code: number }[] } }).__live);
    // Delays: 1s, 2s, 4s, 8s, 16s, then capped at 30s; each jittered +-25%.
    const bases = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000];
    for (let k = 0; k < bases.length; k++) {
      // attempt k+1 has been made, and its 1013 close has reached the page
      await expect.poll(async () => (await live()).closes.length, { timeout: 10_000 }).toBe(k + 1);
      expect(accepted).toBe(k + 1);
      // Just short of the earliest the retry may fire: nothing new.
      await page.clock.runFor(bases[k] * 0.75 - 50);
      await page.waitForTimeout(100); // before asserting that something did *not* happen
      expect((await live()).connects, `no retry before ${0.75 * bases[k] - 50} ms`).toHaveLength(k + 1);
      // Past the latest it may fire: exactly one retry, not a burst.
      await page.clock.runFor(bases[k] * 0.5 + 100);
      await expect.poll(async () => (await live()).connects.length, { timeout: 10_000 }).toBe(k + 2);
    }
    await expect.poll(async () => (await live()).closes.length, { timeout: 10_000 }).toBe(bases.length + 1);

    const { connects, closes } = await live();
    expect(closes.every((c) => c.code === 1013)).toBe(true);
    const delays = connects.slice(1).map((at, k) => at - closes[k].at);
    delays.forEach((d, k) => {
      expect(d, `delay ${k + 1}`).toBeGreaterThanOrEqual(bases[k] * 0.75 - 1);
      expect(d, `delay ${k + 1}`).toBeLessThanOrEqual(bases[k] * 1.25 + 1);
    });
    // The server accepting the upgrade each time must not reset the backoff,
    // and the cap holds: the last three delays are all about 30s.
    expect(delays[delays.length - 1]).toBeGreaterThanOrEqual(30_000 * 0.75 - 1);

    // The UI carries on from polling: planes still draw, nothing threw, and
    // the client neither logged an error per attempt nor reopened the poll
    // window from a reconnect (page load's one call is the allowed one).
    await page.clock.resume();
    const target = LIVE_FIXTURE[0];
    await setMapView(page, target.latitude, target.longitude, 11);
    await waitForPlanes(page);
    expect(pageErrors).toEqual([]);
    expect(liveFeedLogs).toEqual([]);
    expect(restarts).toHaveLength(1);
  });

  test("does not reconnect after a policy-violation close", async ({ page }) => {
    await mockFlightApi(page);
    let connects = 0;
    await page.routeWebSocket("**/ws/live", (ws) => {
      connects++;
      setTimeout(() => ws.close({ code: 1008, reason: "policy" }), 20);
    });
    await page.goto("/");
    await page.waitForTimeout(3_000);
    expect(connects).toBe(1);
  });

  test("keepalive and malformed text frames are ignored without errors", async ({ page }) => {
    await mockFlightApi(page);
    await page.routeWebSocket("**/ws/live", (ws) => {
      ws.send(JSON.stringify({ type: "ping" }));
      ws.send("not json");
    });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("/");
    await waitForMapReady(page);
    await page.waitForTimeout(1_000);
    expect(errors).toEqual([]);
  });
});
