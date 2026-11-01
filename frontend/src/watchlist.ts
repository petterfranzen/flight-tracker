/** Watched flights (flight number + day), kept in localStorage only, like favorites.ts. */
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
