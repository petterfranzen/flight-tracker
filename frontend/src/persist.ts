/**
 * Shared client-side storage for favorites (routes and aircraft, see
 * favorites.ts) and watched flights (watchlist.ts). Still accountless and
 * browser-private — nothing here reaches the server.
 *
 * localStorage is the primary copy; a first-party cookie is a second one,
 * written through the same calls. localStorage is the better store (larger,
 * no per-request cost) but the cookie survives the one thing localStorage
 * doesn't: Safari's tracking prevention clears localStorage after seven days
 * without a visit, while a JS-set cookie lasts (still only seven days on
 * Safari; that limit is the browser's, not ours — see the README note).
 *
 * The cookie is set from JS, never read or set by the backend, and carries
 * only the favorites/watched JSON. It does ride along on /api requests: a
 * cookie with Path=/ is sent on every same-origin request no matter who set
 * it. The value is kept compact and capped (see VALUE_BUDGET_BYTES) so that
 * overhead stays a few hundred bytes, not kilobytes.
 *
 * Every access is wrapped — storage can throw (private browsing, disabled
 * site data, a storage quota) and a silent empty list is a better failure
 * mode for a favorites list than a broken map.
 */

/** Chrome caps cookie lifetime at 400 days; every current browser accepts this. */
const MAX_AGE_SECONDS = 400 * 24 * 60 * 60;

/**
 * Cap on the *encoded* cookie value (what the browser counts), chosen to stay
 * comfortably under the ~4096-byte cookie limit with room for the name and
 * attributes. A longer list is trimmed to this: the oldest entries are
 * dropped from the cookie only — localStorage keeps the full list — so the
 * app never breaks and nothing is lost while localStorage survives.
 */
export const VALUE_BUDGET_BYTES = 3500;

/** Cookie name for a storage key. Cookie names can't carry ":", so keys are flattened. */
export function cookieNameFor(key: string): string {
  return `ft_${key.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

/**
 * Drops null/undefined fields before serializing, so an empty route IATA or
 * registration doesn't cost bytes in the cookie. Parses back to the same
 * shape (those fields are nullable anyway).
 */
function compact<T>(list: T[]): unknown[] {
  return list.map((entry) => {
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(entry as Record<string, unknown>)) {
        if (v !== null && v !== undefined) out[k] = v;
      }
      return out;
    }
    return entry;
  });
}

/** Length of a cookie value as the browser stores it (`encodeURIComponent`'d). */
export function encodedLength(value: string): number {
  return encodeURIComponent(value).length;
}

/**
 * Trims `list` from the front (oldest first — lists are appended to) until its
 * serialized form fits `budget` encoded bytes. A single entry too big to fit
 * on its own trims to `[]`: the cookie is dropped rather than left oversized
 * (an oversized cookie is silently discarded by the browser anyway).
 * Returns the trimmed list; it is always a suffix of the input.
 */
export function fitToBudget<T>(list: T[], budget = VALUE_BUDGET_BYTES): T[] {
  let items = list;
  while (items.length > 0 && encodedLength(JSON.stringify(compact(items))) > budget) {
    items = items.slice(1);
  }
  return items;
}

/** Compact (null-stripped, budget-trimmed) JSON for the cookie. */
export function serializeForCookie<T>(list: T[]): string {
  return JSON.stringify(compact(fitToBudget(list)));
}

/** Parses a stored JSON list. Returns null when absent, empty or not an array. */
export function parseList<T>(raw: string | null | undefined): T[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : null;
  } catch {
    return null;
  }
}

function readLocal<T>(key: string): T[] | null {
  try {
    return parseList<T>(localStorage.getItem(key));
  } catch {
    return null;
  }
}

function writeLocal<T>(key: string, list: T[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(list));
  } catch {
    // best-effort — see module comment
  }
}

function readCookie(name: string): string | null {
  const prefix = `${name}=`;
  try {
    for (const part of document.cookie.split("; ")) {
      if (part.startsWith(prefix)) {
        try {
          return decodeURIComponent(part.slice(prefix.length));
        } catch {
          return null;
        }
      }
    }
  } catch {
    // no document (e.g. a non-DOM context) — treat as no cookie
  }
  return null;
}

function writeCookie(name: string, value: string): void {
  try {
    const secure = typeof location !== "undefined" && location.protocol === "https:" ? "; Secure" : "";
    document.cookie = `${name}=${encodeURIComponent(value)}; Path=/; SameSite=Lax; Max-Age=${MAX_AGE_SECONDS}${secure}`;
  } catch {
    // best-effort — see module comment
  }
}

/**
 * Reads a list, localStorage first and cookie as the fallback, and keeps the
 * two in sync: whichever store held the value re-seeds the other when it is
 * missing. Returns [] when neither has anything usable. A present-but-empty
 * list (the user removed everything) is trusted as-is, so it can't be
 * resurrected from a stale cookie.
 */
export function loadList<T>(key: string): T[] {
  const cookieName = cookieNameFor(key);
  const local = readLocal<T>(key);
  if (local !== null) {
    if (readCookie(cookieName) === null) writeCookie(cookieName, serializeForCookie(local));
    return local;
  }
  const cookie = parseList<T>(readCookie(cookieName));
  if (cookie !== null) {
    writeLocal(key, cookie);
    return cookie;
  }
  return [];
}

/** Writes a list to both stores: localStorage whole, the cookie compact and capped. */
export function saveList<T>(key: string, list: T[]): void {
  writeLocal(key, list);
  writeCookie(cookieNameFor(key), serializeForCookie(list));
}
