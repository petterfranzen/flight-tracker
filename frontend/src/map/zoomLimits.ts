// Pure, Leaflet-free: how far out the map may zoom for a given screen.

const TILE_PX = 256;
const MERCATOR_MAX_LAT = 85.0511;

/**
 * The lowest zoom at which one copy of the world still covers the whole
 * screen (the Mercator world is a square, 256 * 2^zoom px a side). Any lower
 * and the screen is wider or taller than the world: maxBounds can't hold the
 * view, and the world repeats beside itself or the poles' blank edge shows.
 * Never below 2, the app's floor.
 */
export function minZoomFor(widthPx: number, heightPx: number): number {
  const longest = Math.max(widthPx, heightPx, 1);
  return Math.max(2, Math.ceil(Math.log2(longest / TILE_PX)));
}

/** Panning limits: the Mercator world exactly (the poles beyond ±85° aren't drawn). */
export const WORLD_BOUNDS: [[number, number], [number, number]] = [
  [-MERCATOR_MAX_LAT, -180],
  [MERCATOR_MAX_LAT, 180],
];
