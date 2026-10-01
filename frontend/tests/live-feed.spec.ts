import { expect, test } from "@playwright/test";
import { mockFlightApi } from "./helpers";

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
    for (let i = 1; i < gaps.length; i++) expect(gaps[i]).toBeGreaterThan(gaps[i - 1]);

    const origin = new URL(page.url());
    expect(connects[0].url).toBe(`ws://${origin.host}/ws/live`);
    // Page load with the poll window closed (mockFlightApi's status says
    // inactive) is the one allowed caller here — once, not per reconnect.
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
    await page.waitForSelector(".leaflet-container");
    await page.waitForTimeout(1_000);
    expect(errors).toEqual([]);
  });
});
