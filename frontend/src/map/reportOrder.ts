// Pure, map-free: ordering payloads by the instant the report they carry was made.

// `observedAt` is an ISO-8601 string, and the server does not promise a single
// spelling of it: the same instant can arrive as `...Z` or `...+00:00`, with or
// without fractional seconds. Comparing the strings orders them by their *text*,
// which disagrees with the instant they name:
//
//   "2026-01-01T09:00:00Z"  <  "2026-01-01T10:00:00+02:00"   (text order)
//   but 09:00Z is 09:00 and 10:00+02:00 is 08:00 — the textually-later string
//   is the earlier instant, so a stale report reads as newer: a frame that
//   should move a marker is ignored, or one that should be kept is applied.
//
//   "2026-01-01T10:00:00.500Z"  <  "2026-01-01T10:00:00Z"    (text order)
//   but half a second past 10:00 is later than 10:00 exactly — 'Z' sorts after
//   '.', so the text leans the wrong way again.
//
// Every ordering decision here goes through Date.parse, so any two spellings of
// one instant compare equal and the order follows real time.

/** Milliseconds since the epoch for a report's `observedAt`. */
export function observedAtMs(observedAt: string): number {
  return Date.parse(observedAt);
}

/** Whether a and b are the same report — the same instant, however it is spelled. */
export function sameReport(a: string, b: string): boolean {
  return observedAtMs(a) === observedAtMs(b);
}

/** Whether a is a strictly later report than b. */
export function newerReport(a: string, b: string): boolean {
  return observedAtMs(a) > observedAtMs(b);
}

/** Whether a is the same report as b or a later one (an `at or after` test). */
export function notOlderReport(a: string, b: string): boolean {
  return observedAtMs(a) >= observedAtMs(b);
}
