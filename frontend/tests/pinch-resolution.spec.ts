import { expect, test } from "@playwright/test";
import { createPinchResolution, PINCH_RESTORE_DELAY_MS } from "../src/map/pinchResolution";

// Two fingers down (a pinch) drops the vector basemap to pixel ratio 1; it is restored shortly after
// the fingers lift. A manual clock stands in for setTimeout.
function setup(full = 2) {
  const applied: number[] = [];
  let pending: { fn: () => void; at: number } | null = null;
  let now = 0;
  const pinch = createPinchResolution({
    full,
    low: 1,
    apply: (r) => applied.push(r),
    schedule: (fn, ms) => (pending = { fn, at: now + ms }),
    cancel: () => (pending = null),
  });
  const advance = (ms: number) => {
    now += ms;
    if (pending && pending.at <= now) {
      const { fn } = pending;
      pending = null;
      fn();
    }
  };
  return { pinch, applied, advance, hasPending: () => pending !== null };
}

test.describe("pinch resolution", () => {
  test("one finger (a pan or a tap) changes nothing", () => {
    const { pinch, applied } = setup();
    pinch.touches(1);
    pinch.touches(0);
    expect(applied).toEqual([]);
  });

  test("two fingers drop to 1x immediately, once", () => {
    const { pinch, applied } = setup();
    pinch.touches(2);
    pinch.touches(2);
    pinch.touches(2);
    expect(applied).toEqual([1]);
  });

  test("full resolution returns a moment after the fingers lift, not at once", () => {
    const { pinch, applied, advance } = setup();
    pinch.touches(2);
    pinch.touches(1);
    advance(PINCH_RESTORE_DELAY_MS - 10);
    expect(applied).toEqual([1]);
    advance(20);
    expect(applied).toEqual([1, 2]);
  });

  test("a second pinch before the restore keeps it low (no flicker between pinches)", () => {
    const { pinch, applied, advance, hasPending } = setup();
    pinch.touches(2);
    pinch.touches(0);
    advance(100);
    pinch.touches(2);
    expect(hasPending()).toBe(false);
    advance(1000);
    expect(applied).toEqual([1]);
  });

  test("a 1x screen has nothing to save, so nothing is ever changed", () => {
    const { pinch, applied } = setup(1);
    pinch.touches(2);
    pinch.touches(0);
    expect(applied).toEqual([]);
  });
});
