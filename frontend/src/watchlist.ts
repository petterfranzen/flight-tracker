/** Watched flights (flight number + day), kept in localStorage only, like favorites.ts. */
export interface WatchedFlight {
  flightNumber: string;
  date: string; // yyyy-MM-dd, Swedish local date of the board
  airport: string; // the Swedavia airport whose board holds it
  label: string; // "LHR → ARN"
}

import type { ScheduledFlight } from "./api/flightApi";

const KEY = "flighttracker:watchedFlights";

/** Case-, space- and hyphen-insensitive form of a flight number or callsign ("sk 528" / "SAS-528" -> "SK528" / "SAS528"). */
export function normalizeFlightNo(s: string | null | undefined): string {
  return (s ?? "").toUpperCase().replace(/[\s-]/g, "");
}

/**
 * Whether a typed search query matches a watched flight. Matches the IATA number
 * as typed (SK528) as well as the ICAO callsign the schedule row carries once the
 * board matched it (SAS528 -> callsign "SAS528"); a prefix match, so "SK5" finds
 * SK528. The two are different identifiers (the callsign is the airline ICAO code
 * plus the flight's number), which is why both are tried.
 */
export function watchedMatchesQuery(w: WatchedFlight, status: ScheduledFlight | null, query: string): boolean {
  const q = normalizeFlightNo(query);
  if (!q) return false;
  return normalizeFlightNo(w.flightNumber).startsWith(q) || normalizeFlightNo(status?.callsign).startsWith(q);
}

export function watchKey(w: Pick<WatchedFlight, "flightNumber" | "date" | "airport">): string {
  return `${w.flightNumber}|${w.date}|${w.airport}`;
}

export function loadWatched(): WatchedFlight[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveWatched(list: WatchedFlight[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // best-effort, like favorites
  }
}
