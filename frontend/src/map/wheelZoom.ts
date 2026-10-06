// Pure, Leaflet-free: turns a stream of wheel events into whole zoom steps.
//
// Leaflet's own handler turns every ~40 ms burst of wheel events into a full
// zoom level, so a spinning wheel or a touchpad swipe (dozens of small events
// plus inertia) queues many animated zooms in a row, each followed by a
// viewport fetch and a marker re-layout. Here a gesture is one step at a time:
// enough accumulated scroll for one level makes one step, then further events
// are ignored until the animation has had time to finish.

/** Scroll, in px, that adds up to one zoom level. One wheel notch (100-120) is one level. */
export const WHEEL_STEP_PX = 100;
/** After a step, events are dropped for this long (just over the 250 ms zoom animation). */
export const WHEEL_COOLDOWN_MS = 300;
/** A gap this long between events starts a new gesture: leftovers are forgotten. */
export const WHEEL_IDLE_RESET_MS = 150;
/** A touchpad pinch arrives as ctrl+wheel with tiny deltas (a few px per event). */
const PINCH_GAIN = 5;

const DOM_DELTA_LINE = 1;
const DOM_DELTA_PAGE = 2;

export interface WheelInput {
  deltaY: number;
  /** WheelEvent.deltaMode: 0 pixels, 1 lines, 2 pages. */
  deltaMode: number;
  /** ctrl held: a touchpad pinch (or a ctrl+wheel). */
  ctrlKey: boolean;
  /** performance.now()-style timestamp, ms. */
  now: number;
}

export interface WheelStepper {
  /** +1 zoom in, -1 zoom out, 0 nothing yet (or dropped). */
  feed(input: WheelInput): -1 | 0 | 1;
}

export function createWheelStepper(): WheelStepper {
  let accumulated = 0;
  let lastAt = -Infinity;
  let lockedUntil = -Infinity;

  return {
    feed({ deltaY, deltaMode, ctrlKey, now }) {
      if (now < lockedUntil) {
        lastAt = now;
        return 0;
      }
      if (now - lastAt > WHEEL_IDLE_RESET_MS) accumulated = 0;
      lastAt = now;

      let px = deltaMode === DOM_DELTA_LINE ? deltaY * 16 : deltaMode === DOM_DELTA_PAGE ? deltaY * 120 : deltaY;
      if (ctrlKey) px *= PINCH_GAIN;
      // Scrolling the other way mid-gesture starts over rather than cancelling out.
      if (accumulated !== 0 && Math.sign(px) !== Math.sign(accumulated)) accumulated = 0;
      accumulated += px;

      if (Math.abs(accumulated) < WHEEL_STEP_PX) return 0;
      const step = accumulated < 0 ? 1 : -1; // wheel up (negative deltaY) zooms in
      accumulated = 0;
      lockedUntil = now + WHEEL_COOLDOWN_MS;
      return step;
    },
  };
}
