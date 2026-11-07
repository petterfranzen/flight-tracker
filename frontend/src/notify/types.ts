import type { ScheduledFlight, ScheduleStatus } from "../api/flightApi";
import type { FlightPosition } from "../types/flight";

/**
 * Per-flight notification state (#82 design §2), kept in localStorage keyed by
 * `watchKey`. The detector advances it once per background poll; `enabled` is
 * the user's opt-in for the OS notification (the in-app banner never needs it).
 */
export interface FlightNotifyState {
  enabled: boolean;
  icao24: string | null;
  /** Last row's `airborne`, null before the first observation. */
  airborne: boolean | null;
  everAirborne: boolean;
  /** Consecutive polls the row has said airborne. */
  airborneStreak: number;
  /** The streak started from a seen-on-ground poll (a real take-off edge). */
  edgeFromGround: boolean;
  /** Consecutive polls the live position has said onGround. */
  onGroundStreak: number;
  /** Event kinds already announced for this flight. */
  lastEventKeys: string[];
  /** Timestamps of the events sent, for the hourly cap. */
  sentAt: number[];
}

export type NotifyMap = Record<string, FlightNotifyState>;

/** One poll's worth of inputs for one watched flight. */
export interface FlightSample {
  key: string;
  row: ScheduledFlight | null;
  boardStatus?: ScheduleStatus;
  position?: Pick<FlightPosition, "onGround"> | null;
  nowMs: number;
}

export interface FlightEvent {
  key: string;
  kind: "takeoff" | "landed";
  title: string;
  text: string;
  row: ScheduledFlight;
  nowMs: number;
}
