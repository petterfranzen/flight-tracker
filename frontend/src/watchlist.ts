/**
 * Watched flights (flight number + day), kept in localStorage with a
 * same-origin cookie as a second copy, like favorites.ts — see persist.ts.
 */
import { loadList, saveList } from "./persist";

export interface WatchedFlight {
  flightNumber: string;
  date: string; // yyyy-MM-dd, Swedish local date of the board
  airport: string; // the Swedavia airport whose board holds it
  label: string; // "LHR → ARN"
}

const KEY = "flighttracker:watchedFlights";

export function watchKey(w: Pick<WatchedFlight, "flightNumber" | "date" | "airport">): string {
  return `${w.flightNumber}|${w.date}|${w.airport}`;
}

export function loadWatched(): WatchedFlight[] {
  return loadList<WatchedFlight>(KEY);
}

export function saveWatched(list: WatchedFlight[]): void {
  saveList(KEY, list);
}
