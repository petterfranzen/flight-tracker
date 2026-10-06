import { expect, test } from "@playwright/test";
import { createWheelStepper, WHEEL_COOLDOWN_MS, type WheelInput } from "../src/map/wheelZoom";
import type { Page } from "@playwright/test";
import { mockFlightApi, setMapView, withMap } from "./helpers";

/** Fires `count` wheel events in one task (a real burst arrives within a few ms), at the map's centre. */
async function wheelBurst(page: Page, count: number, deltaY: number): Promise<void> {
  await page.evaluate(
    ({ count, deltaY }) => {
      const el = document.querySelector(".leaflet-container")!;
      const r = el.getBoundingClientRect();
      for (let i = 0; i < count; i++) {
        el.dispatchEvent(new WheelEvent("wheel", { deltaY, bubbles: true, cancelable: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 }));
      }
    },
    { count, deltaY },
  );
}

// Wheel and touchpad zoom goes one level at a time (map/wheelZoom.ts): a spinning wheel or a
// touchpad swipe used to queue a zoom animation, viewport fetch and marker re-layout per burst.

const ev = (deltaY: number, now: number, extra: Partial<WheelInput> = {}): WheelInput => ({ deltaY, deltaMode: 0, ctrlKey: false, now, ...extra });
const run = (events: WheelInput[]): number[] => {
  const s = createWheelStepper();
  return events.map((e) => s.feed(e));
};
const total = (steps: number[]) => steps.reduce((a, b) => a + Math.abs(b), 0);

test.describe("wheel stepper (pure)", () => {
  test("one wheel notch is one level: up zooms in, down zooms out", () => {
    expect(run([ev(-100, 0)])).toEqual([1]);
    expect(run([ev(100, 0)])).toEqual([-1]);
    expect(run([ev(-120, 0)])).toEqual([1]); // 120 is the other common notch size
  });

  test("a touchpad swipe (many small events) is one step, not one per event", () => {
    const events = Array.from({ length: 40 }, (_, i) => ev(-4, i * 16)); // 160 px over 640 ms
    expect(total(run(events))).toBe(1);
  });

  test("a fast-spinning wheel steps at most once per cooldown, not once per notch", () => {
    const events = Array.from({ length: 20 }, (_, i) => ev(-100, i * 40)); // 20 notches in 800 ms
    const n = total(run(events));
    expect(n).toBeGreaterThanOrEqual(2);
    expect(n).toBeLessThanOrEqual(Math.ceil(800 / WHEEL_COOLDOWN_MS) + 1);
  });

  test("events during the cooldown are dropped, not saved up for later", () => {
    const s = createWheelStepper();
    expect(s.feed(ev(-100, 0))).toBe(1);
    for (let t = 20; t < WHEEL_COOLDOWN_MS; t += 20) expect(s.feed(ev(-100, t))).toBe(0);
    // Nothing was banked: a small nudge right after the cooldown does not step.
    expect(s.feed(ev(-30, WHEEL_COOLDOWN_MS + 10))).toBe(0);
  });

  test("scroll that stops short is forgotten after a pause", () => {
    expect(run([ev(-60, 0), ev(-60, 400)])).toEqual([0, 0]);
    expect(run([ev(-60, 0), ev(-60, 20)])).toEqual([0, 1]); // but the same scroll in one go steps
  });

  test("reversing direction mid-gesture starts over (it does not cancel out the scroll so far)", () => {
    expect(run([ev(-60, 0), ev(60, 10)])).toEqual([0, 0]); // 60 up then 60 down is not "net zero then stuck": a fresh 60
    expect(run([ev(-60, 0), ev(60, 10), ev(60, 20)])).toEqual([0, 0, -1]); // keep going down: one step out
  });

  test("line-mode wheels (Firefox) and ctrl+wheel touchpad pinches are scaled to the same step", () => {
    expect(total(run(Array.from({ length: 8 }, (_, i) => ev(-1, i * 16, { deltaMode: 1 }))))).toBe(1); // 8 lines = 128 px
    expect(total(run(Array.from({ length: 8 }, (_, i) => ev(-3, i * 16, { ctrlKey: true }))))).toBe(1); // tiny pinch deltas
  });
});

test.describe("stepped zoom in the app", () => {
  test("a burst of small touchpad-style wheel events is one zoom level", async ({ page }) => {
    await mockFlightApi(page);
    await page.goto("/");
    await page.waitForSelector(".leaflet-container", { timeout: 10_000 });
    await setMapView(page, 59.3, 18.0, 7);
    await wheelBurst(page, 30, -12); // 360 px of swipe, in one go
    await page.waitForTimeout(500);
    expect(await withMap(page, (m) => m.getZoom())).toBe(8);
  });

  test("notches spaced past the cooldown each step; rapid ones are coalesced", async ({ page }) => {
    await mockFlightApi(page);
    await page.goto("/");
    await page.waitForSelector(".leaflet-container", { timeout: 10_000 });
    await setMapView(page, 59.3, 18.0, 7);
    await wheelBurst(page, 6, -100); // six notches in a blink
    await page.waitForTimeout(500);
    expect(await withMap(page, (m) => m.getZoom())).toBe(8);
    await wheelBurst(page, 1, 100); // one notch after the cooldown
    await page.waitForTimeout(500);
    expect(await withMap(page, (m) => m.getZoom())).toBe(7);
  });

  test("it zooms around the pointer, and the page does not scroll", async ({ page }) => {
    await mockFlightApi(page);
    await page.goto("/");
    await page.waitForSelector(".leaflet-container", { timeout: 10_000 });
    await setMapView(page, 59.3, 18.0, 7);
    const box = (await page.locator(".leaflet-container").boundingBox())!;
    const px = box.x + box.width * 0.75;
    const py = box.y + box.height * 0.25;
    const before = await withMap(page, (m, x: number, y: number) => m.containerPointToLatLng([x, y]), px - box.x, py - box.y);
    await page.mouse.move(px, py);
    await page.mouse.wheel(0, -100);
    await page.waitForTimeout(500);
    const after = await withMap(page, (m, x: number, y: number) => m.containerPointToLatLng([x, y]), px - box.x, py - box.y);
    expect(Math.abs(after.lat - before.lat)).toBeLessThan(0.05);
    expect(Math.abs(after.lng - before.lng)).toBeLessThan(0.05);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
  });
});
