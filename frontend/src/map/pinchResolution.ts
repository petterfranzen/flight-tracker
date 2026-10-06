// Pure, DOM-free: while two fingers are down (a pinch zoom), the vector basemap
// is drawn at a lower pixel ratio. Every pinch frame re-renders the GL canvas
// at a fractional zoom; on a 2x phone that is four times the pixels of a 1x
// render for a view that is moving too fast to see the difference. Sharpness
// returns shortly after the fingers lift, once the settle animation is done.

export const PINCH_RESTORE_DELAY_MS = 350;

export interface PinchResolution {
  /** Call with the number of fingers currently touching the map. */
  touches(count: number): void;
  /** Stops any pending restore (the layer is going away). */
  dispose(): void;
}

export function createPinchResolution(opts: {
  full: number;
  low: number;
  apply(pixelRatio: number): void;
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
}): PinchResolution {
  const schedule = opts.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  const cancel = opts.cancel ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  let lowered = false;
  let restore: unknown = null;

  const clearRestore = (): void => {
    if (restore !== null) cancel(restore);
    restore = null;
  };

  return {
    touches(count) {
      if (opts.low >= opts.full) return; // a 1x screen has nothing to save
      if (count >= 2) {
        clearRestore();
        if (!lowered) {
          lowered = true;
          opts.apply(opts.low);
        }
      } else if (lowered && restore === null) {
        restore = schedule(() => {
          restore = null;
          lowered = false;
          opts.apply(opts.full);
        }, PINCH_RESTORE_DELAY_MS);
      }
    },
    dispose: clearRestore,
  };
}
