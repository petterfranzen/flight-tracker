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
  const row = readableRow(sample);
  if (!row) return { state, event: null };

  const nowAirborne = row.airborne === true;
  const next: FlightNotifyState = {
    ...state,
    ...airborneStreak(state, nowAirborne),
    onGroundStreak: onGroundStreak(state, sample),
    airborne: nowAirborne,
    icao24: row.icao24 ?? state.icao24,
  };

  if (takeoffDue(next)) {
    return announce(next, sample, row, { kind: "takeoff", text: `${row.flightNumber} ${routeOf(row)} is airborne.` });
  }
  if (landingDue(next)) {
    return announce(next, sample, row, {
      kind: "landed",
      text: `${row.flightNumber} landed at ${row.airport}, ${timeLabel(row.actual, sample.nowMs)}.`,
    });
  }
  return { state: next, event: null };
}

type Row = NonNullable<FlightSample["row"]>;

/** The row to read, or null: no row, or the board answered `stale`/`incomplete`. */
function readableRow(sample: FlightSample): Row | null {
  if (sample.boardStatus && sample.boardStatus !== "ok") return null;
  return sample.row ?? null;
}

type AirborneFields = Pick<FlightNotifyState, "airborneStreak" | "edgeFromGround" | "everAirborne">;

/** The airborne edge and its two-tick confirmation. */
function airborneStreak(state: FlightNotifyState, nowAirborne: boolean): Partial<AirborneFields> {
  if (!nowAirborne) return { airborneStreak: 0, edgeFromGround: false };
  if (state.airborne === false) return { airborneStreak: 1, edgeFromGround: true, everAirborne: true };
  if (state.airborne === true) return { airborneStreak: state.airborneStreak + 1, edgeFromGround: state.edgeFromGround, everAirborne: true };
  // First observation: no edge, so a flight already in the air is not a take-off.
  return { airborneStreak: 1, edgeFromGround: false, everAirborne: true };
}

/** The on-ground streak for landings. */
function onGroundStreak(state: FlightNotifyState, sample: FlightSample): number {
  if (sample.position?.onGround !== true) return 0;
  return state.onGroundStreak > 0 ? state.onGroundStreak + 1 : 1;
}

function takeoffDue(next: FlightNotifyState): boolean {
  const confirmed = next.airborne === true && next.edgeFromGround && next.airborneStreak >= 2;
  return confirmed && !next.lastEventKeys.includes("takeoff");
}

function landingDue(next: FlightNotifyState): boolean {
  const confirmed = next.everAirborne && next.onGroundStreak >= 2;
  return confirmed && !next.lastEventKeys.includes("landed");
}

function announce(
  next: FlightNotifyState,
  sample: FlightSample,
  row: Row,
  event: Pick<FlightEvent, "kind" | "text">,
): { state: FlightNotifyState; event: FlightEvent } {
  return {
    state: { ...next, lastEventKeys: [...next.lastEventKeys, event.kind], sentAt: [...next.sentAt, sample.nowMs] },
    event: { key: sample.key, kind: event.kind, title: row.flightNumber, text: event.text, row, nowMs: sample.nowMs },
  };
}

export type Channel = "banner" | "os" | "none";

/**
 * One event, one channel. A visible tab gets the in-app banner; a hidden tab
 * with permission and the flight opted in gets the OS notification. Without
 * permission the banner is the floor and still carries the event.
 */
export function chooseChannel(opts: { hidden: boolean; enabled: boolean; permission: NotificationPermission | "unsupported" }): Channel {
  const osAllowed = opts.enabled && opts.permission === "granted";
  return opts.hidden && osAllowed ? "os" : "banner";
}
