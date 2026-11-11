import type { FlightNotifyState, NotifyMap } from "./types";

/** One key for every watched flight's notification state (#82 design §2). */
export const NOTIFY_STORAGE_KEY = "flighttracker:watchNotify";

const HOUR_MS = 60 * 60 * 1000;
const RETENTION_MS = 72 * HOUR_MS;

export function emptyState(): FlightNotifyState {
  return {
    enabled: false,
    icao24: null,
    airborne: null,
    everAirborne: false,
    airborneStreak: 0,
    edgeFromGround: false,
    onGroundStreak: 0,
    lastEventKeys: [],
    sentAt: [],
  };
}

/**
 * The instant a flight's notification state expires: the end of its Swedish
 * day plus 72 h. The +01:00 offset is Sweden's standard time; in summer the
 * entry is pruned an hour early, which can only forget a notification sooner,
 * never repeat one.
 */
export function flightExpiryMs(date: string): number {
  const endOfDay = Date.parse(`${date}T23:59:59+01:00`);
  return Number.isFinite(endOfDay) ? endOfDay + RETENTION_MS : 0;
}

/** Drops expired flights and sentAt stamps older than the hourly window. */
export function pruneNotifyState(map: NotifyMap, nowMs = Date.now()): NotifyMap {
  const out: NotifyMap = {};
  for (const [key, state] of Object.entries(map)) {
    const date = key.split("|")[1];
    if (!date || flightExpiryMs(date) <= nowMs) continue;
    out[key] = {
      ...emptyState(),
      ...state,
      lastEventKeys: Array.isArray(state.lastEventKeys) ? state.lastEventKeys : [],
      sentAt: (Array.isArray(state.sentAt) ? state.sentAt : []).filter((t) => nowMs - t < HOUR_MS),
    };
  }
  return out;
}

export function loadNotifyState(nowMs = Date.now()): NotifyMap {
  try {
    const raw = localStorage.getItem(NOTIFY_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as NotifyMap;
    return parsed && typeof parsed === "object" ? pruneNotifyState(parsed, nowMs) : {};
  } catch {
    return {};
  }
}

export function saveNotifyState(map: NotifyMap): void {
  try {
    localStorage.setItem(NOTIFY_STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Private mode or a full quota: notifications still work for this page.
  }
}

/** Reads one flight's state without writing anything back. */
export function notifyStateFor(key: string, nowMs = Date.now()): FlightNotifyState {
  return loadNotifyState(nowMs)[key] ?? emptyState();
}

/** Flips the per-flight OS-notification opt-in and persists it. */
export function setFlightEnabled(key: string, enabled: boolean, nowMs = Date.now()): FlightNotifyState {
  const map = loadNotifyState(nowMs);
  const next = { ...(map[key] ?? emptyState()), enabled };
  map[key] = next;
  saveNotifyState(pruneNotifyState(map, nowMs));
  return next;
}

/** Removes a flight's state in the same click that stops watching it. */
export function forgetFlight(key: string, nowMs = Date.now()): void {
  const map = loadNotifyState(nowMs);
  if (!(key in map)) return;
  delete map[key];
  saveNotifyState(map);
}

/** Prunes the stored map and writes it back (the load job and the hourly job). */
export function pruneNotifyStorage(nowMs = Date.now()): void {
  saveNotifyState(pruneNotifyState(loadNotifyState(nowMs), nowMs));
}

/**
 * #82 design §2: prune expired notification state on load and once an hour.
 * Returns a disposer that clears the interval, so the caller can stop it when
 * the page goes away and the timer never outlives the document it was started
 * for (QA: "the hourly prune setInterval should be cleaned up").
 */
export function startHourlyPrune(): () => void {
  pruneNotifyStorage();
  const timer = setInterval(() => pruneNotifyStorage(), HOUR_MS);
  return () => clearInterval(timer);
}
