import { getMockPlaneCount } from "../api/mockFleet";
import { ValueStore } from "../persist";
import { INITIAL_ZOOM } from "./initialView";
import type { FlightMap } from "./map";

/**
 * The map view the user last settled on, remembered in the browser so the next
 * visit opens there instead of wherever the server's IP lookup guesses
 * (section9-hq#447: a Swedish ISP address that geolocates to the wrong city
 * beat the Stockholm default). The order the opening view is chosen in lives in
 * main.ts `applyInitialView`.
 *
 * Only the centre and zoom are kept, rounded: 0.01° of latitude is about a
 * kilometre, so a rounded centre is a map position, never the locate button's
 * GPS fix — locate.ts promises that position is never stored.
 *
 * Storage goes through persist.ts (ValueStore), so Safari's 7-day localStorage
 * purge is covered by the cookie copy and every access is already wrapped in
 * try/catch; a browser that refuses storage just never remembers a view.
 */

/** The storage key; browser-local, like favorites and the watch list. */
export const SAVED_VIEW_KEY = "flighttracker:lastView";

/** Older than this the view is forgotten: a trip to another city shouldn't pin the map there forever. */
export const SAVED_VIEW_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** A drag or a wheel zoom fires a burst of moveends; only the view the user settles on is saved. */
const SAVE_DEBOUNCE_MS = 1_000;

/** Centre is rounded to this many degrees before it is kept. */
const ROUND_DEG = 0.01;

export interface SavedView {
  lat: number;
  lon: number;
  zoom: number;
  /** When it was saved, ms since epoch — what the 30-day expiry is measured against. */
  savedAt: number;
}

function round(value: number, step: number): number {
  return Math.round(value / step) * step;
}

/** Centre to 0.01° and zoom to a whole level: the precision worth remembering, and no more. */
export function roundView(lat: number, lon: number, zoom: number): { lat: number; lon: number; zoom: number } {
  return { lat: round(lat, ROUND_DEG), lon: round(lon, ROUND_DEG), zoom: Math.round(zoom) };
}

/** Whether a stored value is a usable view (a hand-edited or half-written key is ignored, not trusted). */
function isValidView(v: Partial<SavedView> | null): v is SavedView {
  return (
    v != null &&
    Number.isFinite(v.lat) &&
    Math.abs(v.lat as number) <= 90 &&
    Number.isFinite(v.lon) &&
    Math.abs(v.lon as number) <= 180 &&
    Number.isFinite(v.zoom) &&
    (v.zoom as number) > 0 &&
    Number.isFinite(v.savedAt)
  );
}

const store = new ValueStore<SavedView>(SAVED_VIEW_KEY);

/** The saved view, or null when there is none, it is malformed, or it is older than SAVED_VIEW_MAX_AGE_MS. */
export function loadSavedView(now: number = Date.now()): SavedView | null {
  const stored = store.load();
  if (!isValidView(stored)) return null;
  if (now - stored.savedAt > SAVED_VIEW_MAX_AGE_MS) return null;
  return stored;
}

/** Saves the (rounded) view, timestamped `now`. */
export function saveSavedView(lat: number, lon: number, zoom: number, now: number = Date.now()): void {
  const view = roundView(lat, lon, zoom);
  store.save({ ...view, savedAt: now });
}

/**
 * A saved zoom below INITIAL_ZOOM draws only aggregated bubbles (see
 * map/initialView.ts), which reads as broken: open at INITIAL_ZOOM instead. A
 * closer zoom is kept as the user left it.
 */
export function clampInitialZoom(zoom: number): number {
  return Math.max(zoom, INITIAL_ZOOM);
}

/**
 * Saves the view the user settles on. Only a view the user moved the map to
 * counts: a camera drive the app makes itself — a selected aircraft's flyTo, a
 * deep link, the ?mockPlanes tool framing its own fleet — starts no user move
 * (FlightMap.onUserMoveStart), so it is never saved. The locate button's move
 * is the same kind of programmatic drive; its GPS fix is never stored, and the
 * view it leaves is saved like any other once the user moves the map.
 */
export function mountSavedView(map: FlightMap): void {
  if (getMockPlaneCount() != null) return; // the dev tool frames its own view
  let userMoved = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  map.onUserMoveStart(() => {
    userMoved = true;
  });
  map.on("moveend", () => {
    if (!userMoved) return;
    userMoved = false;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      const centre = map.getCenter();
      saveSavedView(centre.lat, centre.lon, map.getZoom());
    }, SAVE_DEBOUNCE_MS);
  });
}
