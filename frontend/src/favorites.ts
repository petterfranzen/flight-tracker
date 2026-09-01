/**
 * Client-side-only favorites (routes and aircraft) — localStorage, no
 * backend involved. Deliberate: the app has no user-account model today
 * (Authentik at the Cloudflare Tunnel layer gates network access, not
 * per-user identity inside the app itself), so there's no meaningful
 * "whose favorite is this" to store server-side yet. Browser-private for
 * now; promoting this to a shared/server-side list once real users exist
 * is future work, not this pass.
 */

export interface FavoriteRoute {
  origin: string; // ICAO code
  originName: string | null;
  originIata: string | null;
  destination: string; // ICAO code
  destinationName: string | null;
  destinationIata: string | null;
}

export interface FavoriteAircraft {
  icao24: string;
  registration: string | null;
  callsign: string | null;
}

const ROUTES_KEY = "flighttracker:favoriteRoutes";
const AIRCRAFT_KEY = "flighttracker:favoriteAircraft";

/**
 * Order-independent identity for a route favorite — "KLR to ARN" and "ARN
 * to KLR" are the same favorite, matching how the feature was asked for
 * ("favourite the KLR-ARN route", not one direction of it). Sorting the
 * pair gives a stable key regardless of which airport was origin vs.
 * destination when it was favorited.
 */
export function routeKey(origin: string, destination: string): string {
  return [origin, destination].sort().join("|");
}

// Every localStorage access is wrapped — it can throw (private browsing,
// disabled site data, a storage quota) or simply not persist, and a
// favorites list failing silently (empty list) is a much better failure
// mode here than the map itself breaking.
function loadList<T>(key: string): T[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveList<T>(key: string, list: T[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(list));
  } catch {
    // best-effort — see module comment
  }
}

export function loadFavoriteRoutes(): FavoriteRoute[] {
  return loadList<FavoriteRoute>(ROUTES_KEY);
}

export function loadFavoriteAircraft(): FavoriteAircraft[] {
  return loadList<FavoriteAircraft>(AIRCRAFT_KEY);
}

/** Adds `route` if its (order-independent) pair isn't already favorited, otherwise removes it. Returns the updated list. */
export function toggleFavoriteRoute(routes: FavoriteRoute[], route: FavoriteRoute): FavoriteRoute[] {
  const key = routeKey(route.origin, route.destination);
  const exists = routes.some((r) => routeKey(r.origin, r.destination) === key);
  const next = exists ? routes.filter((r) => routeKey(r.origin, r.destination) !== key) : [...routes, route];
  saveList(ROUTES_KEY, next);
  return next;
}

/** Adds `aircraft` if its icao24 isn't already favorited, otherwise removes it. Returns the updated list. */
export function toggleFavoriteAircraft(aircraft: FavoriteAircraft[], entry: FavoriteAircraft): FavoriteAircraft[] {
  const exists = aircraft.some((a) => a.icao24 === entry.icao24);
  const next = exists ? aircraft.filter((a) => a.icao24 !== entry.icao24) : [...aircraft, entry];
  saveList(AIRCRAFT_KEY, next);
  return next;
}

export function isRouteFavorited(routes: FavoriteRoute[], origin: string, destination: string): boolean {
  const key = routeKey(origin, destination);
  return routes.some((r) => routeKey(r.origin, r.destination) === key);
}

export function isAircraftFavorited(aircraft: FavoriteAircraft[], icao24: string): boolean {
  return aircraft.some((a) => a.icao24 === icao24);
}
