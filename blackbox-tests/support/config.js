// Single source of truth for "which deployment are we testing". Every test
// file imports from here instead of reading process.env itself, so the
// target is always overridable from the outside via BASE_URL alone.

const rawBase = process.env.BASE_URL?.trim() || "http://localhost:8080";
export const BASE_URL = rawBase.replace(/\/+$/, ""); // strip trailing slash
export const WS_URL = BASE_URL.replace(/^http/, "ws") + "/ws/live";

export function apiUrl(path) {
  return `${BASE_URL}${path.startsWith("/") ? path : `/${path}`}`;
}
