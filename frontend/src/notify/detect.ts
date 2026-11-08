import type { FlightEvent, FlightNotifyState, FlightSample } from "./types";

const STOCKHOLM_TIME = new Intl.DateTimeFormat("sv-SE", {
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Europe/Stockholm",
});

function timeLabel(iso: string | null, fallbackMs: number): string {
  if (iso) {
    const parsed = Date.parse(iso);
    if (Number.isFinite(parsed)) return STOCKHOLM_TIME.format(new Date(parsed));
  }
  return STOCKHOLM_TIME.format(new Date(fallbackMs));
}

function routeOf(row: FlightSample["row"]): string {
  if (!row) return "? → ?";
  return `${row.departureIata ?? "?"} → ${row.arrivalIata ?? "?"}`;
}

/**
 * Advances one watched flight's detector state by one poll and returns the
 * event to announce, if any. Pure: no storage, no network, no clock.
 *
 * Take-off: the row's `airborne` flips false -> true and stays true for two
 * consecutive polls (the false flip must be seen, so a flight first observed
 * already in the air never announces a take-off).
 *
 * Landing: the live position's `onGround` is true for two consecutive polls
 * after the flight has been seen airborne. A row's `airborne` merely dropping
 * is not a landing — that also happens when coverage is lost.
 *
 * A row is never read when the board answered `stale`/`incomplete`, and a
 * missing row leaves the state untouched: a failed board never notifies.
 */
export function observeFlight(state: FlightNotifyState, sample: FlightSample): { state: FlightNotifyState; event: FlightEvent | null } {
  if (!sample.row) return { state, event: null };
  if (sample.boardStatus && sample.boardStatus !== "ok") return { state, event: null };

  const row = sample.row;
  const nowAirborne = row.airborne === true;
  const next: FlightNotifyState = { ...state };

  // --- airborne edge and its two-tick confirmation ---
  if (nowAirborne) {
    if (state.airborne === false) {
      next.airborneStreak = 1;
      next.edgeFromGround = true;
    } else if (state.airborne === true) {
      next.airborneStreak = state.airborneStreak + 1;
      next.edgeFromGround = state.edgeFromGround;
    } else {
      // First observation: no edge, so a flight already in the air is not a take-off.
      next.airborneStreak = 1;
      next.edgeFromGround = false;
    }
    next.everAirborne = true;
  } else {
    next.airborneStreak = 0;
    next.edgeFromGround = false;
  }

  // --- on-ground streak for landings ---
  const onGroundNow = sample.position ? sample.position.onGround === true : null;
  if (onGroundNow === true) next.onGroundStreak = state.onGroundStreak > 0 ? state.onGroundStreak + 1 : 1;
  else next.onGroundStreak = 0;

  next.airborne = nowAirborne;
  next.icao24 = row.icao24 ?? state.icao24;

  const keys = next.lastEventKeys;

  if (nowAirborne && next.edgeFromGround && next.airborneStreak >= 2 && !keys.includes("takeoff")) {
    next.lastEventKeys = [...keys, "takeoff"];
    next.sentAt = [...next.sentAt, sample.nowMs];
    return {
      state: next,
      event: {
        key: sample.key,
        kind: "takeoff",
        title: row.flightNumber,
        text: `${row.flightNumber} ${routeOf(row)} is airborne.`,
        row,
        nowMs: sample.nowMs,
      },
    };
  }

  if (next.everAirborne && next.onGroundStreak >= 2 && !keys.includes("landed")) {
    next.lastEventKeys = [...keys, "landed"];
    next.sentAt = [...next.sentAt, sample.nowMs];
    return {
      state: next,
      event: {
        key: sample.key,
        kind: "landed",
        title: row.flightNumber,
        text: `${row.flightNumber} landed at ${row.airport}, ${timeLabel(row.actual, sample.nowMs)}.`,
        row,
        nowMs: sample.nowMs,
      },
    };
  }

  return { state: next, event: null };
}

export type Channel = "banner" | "os" | "none";

/**
 * One event, one channel. A visible tab gets the in-app banner; a hidden tab
 * with permission and the flight opted in gets the OS notification. Without
 * permission the banner is the floor and still carries the event.
 */
export function chooseChannel(opts: { hidden: boolean; enabled: boolean; permission: NotificationPermission | "unsupported" }): Channel {
  if (opts.hidden && opts.enabled && opts.permission === "granted") return "os";
  return "banner";
}
