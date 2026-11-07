import { expect, test } from "@playwright/test";
import { chooseChannel, observeFlight } from "../src/notify/detect";
import { emptyState, pruneNotifyState } from "../src/notify/state";
import type { FlightNotifyState, FlightSample } from "../src/notify/types";
import type { ScheduledFlight } from "../src/api/flightApi";

// Pure detector rules (#82 design §3): no page, no map, no network. The
// two-tick guards, the "never from a failed board" guard, dedup and the 72 h
// prune are all decided here.

const row = (airborne: boolean, overrides: Partial<ScheduledFlight> = {}): ScheduledFlight => ({
  flightNumber: "SK528",
  callsign: "SAS528",
  direction: "arrivals",
  airport: "ARN",
  departureIata: "LHR",
  arrivalIata: "ARN",
  scheduled: "2026-11-02T10:05:00Z",
  estimated: "2026-11-02T10:20:00Z",
  actual: null,
  gate: "F12",
  terminal: "5",
  statusCode: "SCH",
  status: "Scheduled",
  icao24: "4aad15",
  airborne,
  ...overrides,
});

const sample = (state: FlightNotifyState, opts: Partial<FlightSample> & { airborne?: boolean; onGround?: boolean | null; boardStatus?: FlightSample["boardStatus"]; nowMs?: number } = {}) =>
  observeFlight(state, {
    key: "SK528|2026-11-02|ARN",
    row: opts.row === undefined ? row(opts.airborne ?? false) : opts.row,
    position: opts.onGround === null ? null : { onGround: opts.onGround ?? false },
    nowMs: opts.nowMs ?? 1_762_000_000_000,
    boardStatus: opts.boardStatus,
  });

test("take-off needs the airborne edge held for two consecutive polls", () => {
  let state = emptyState();
  // First sighting on the ground: no edge yet.
  let step = sample(state, { airborne: false });
  state = step.state;
  expect(step.event).toBeNull();
  expect(state.airborne).toBe(false);

  // The edge starts here: one airborne poll is not enough.
  step = sample(state, { airborne: true });
  state = step.state;
  expect(step.event).toBeNull();
  expect(state.airborneStreak).toBe(1);

  // The second airborne poll confirms it.
  step = sample(state, { airborne: true });
  expect(step.event?.kind).toBe("takeoff");
  expect(step.event?.text).toBe("SK528 LHR → ARN is airborne.");
  expect(step.state.lastEventKeys).toContain("takeoff");
});

test("a flight first seen already airborne is not a take-off", () => {
  let state = emptyState();
  let step = sample(state, { airborne: true });
  state = step.state;
  expect(step.event).toBeNull();
  step = sample(state, { airborne: true });
  expect(step.event).toBeNull();
  expect(step.state.everAirborne).toBe(true);
});

test("landing needs two on-ground polls after being airborne", () => {
  let state: FlightNotifyState = { ...emptyState(), airborne: true, everAirborne: true, airborneStreak: 2, edgeFromGround: true, lastEventKeys: ["takeoff"] };
  // The row merely dropping airborne is not a landing when no live position proves it.
  let step = sample(state, { airborne: false, onGround: null });
  state = step.state;
  expect(step.event).toBeNull();
  // First on-ground tick: not enough.
  step = sample(state, { airborne: false, onGround: true });
  state = step.state;
  expect(step.event).toBeNull();
  expect(state.onGroundStreak).toBe(1);
  // Second consecutive on-ground tick: landing.
  step = sample(state, { airborne: false, onGround: true });
  expect(step.event?.kind).toBe("landed");
  expect(step.event?.text).toContain("SK528 landed at ARN");
});

test("a touch-and-go resets the on-ground streak and does not announce a landing", () => {
  let state: FlightNotifyState = { ...emptyState(), airborne: true, everAirborne: true, lastEventKeys: ["takeoff"] };
  let step = sample(state, { airborne: true, onGround: true });
  state = step.state;
  expect(step.event).toBeNull();
  // Back in the air before the second tick.
  step = sample(state, { airborne: true, onGround: false });
  state = step.state;
  expect(step.event).toBeNull();
  expect(state.onGroundStreak).toBe(0);
  step = sample(state, { airborne: true, onGround: true });
  expect(step.event).toBeNull();
  expect(step.state.onGroundStreak).toBe(1);
});

test("never notifies from a stale or incomplete board, or a missing row", () => {
  let state: FlightNotifyState = { ...emptyState(), airborne: false };
  let step = sample(state, { airborne: true, boardStatus: "stale" });
  expect(step.event).toBeNull();
  expect(step.state.airborne).toBe(false);

  step = sample(state, { airborne: true, boardStatus: "incomplete" });
  expect(step.event).toBeNull();
  expect(step.state.airborne).toBe(false);

  const before = { ...emptyState(), airborne: false };
  step = sample(before, { row: null });
  expect(step.event).toBeNull();
  expect(step.state).toEqual(before);
});

test("dedup: the same landing key never announces twice", () => {
  const state: FlightNotifyState = { ...emptyState(), airborne: false, everAirborne: true, onGroundStreak: 2, lastEventKeys: ["takeoff", "landed"] };
  const step = sample(state, { airborne: false, onGround: true });
  expect(step.event).toBeNull();
});

test("the 72 h prune drops old flight dates and old sentAt stamps", () => {
  const now = Date.parse("2026-11-05T12:00:00Z");
  const map = {
    "SK1|2026-11-01|ARN": { ...emptyState(), enabled: true, sentAt: [now - 2 * 60 * 60 * 1000] },
    "SK2|2026-11-10|ARN": { ...emptyState(), enabled: true, sentAt: [now - 10 * 60 * 1000] },
  };
  const pruned = pruneNotifyState(map, now);
  expect(Object.keys(pruned)).toEqual(["SK2|2026-11-10|ARN"]);
  expect(pruned["SK2|2026-11-10|ARN"].sentAt).toHaveLength(1);
});

test("one event, one channel: visible gets the banner, hidden+granted+opted-in gets the OS notification", () => {
  expect(chooseChannel({ hidden: false, enabled: true, permission: "granted" })).toBe("banner");
  expect(chooseChannel({ hidden: true, enabled: true, permission: "granted" })).toBe("os");
  expect(chooseChannel({ hidden: true, enabled: false, permission: "granted" })).toBe("banner");
  expect(chooseChannel({ hidden: true, enabled: true, permission: "denied" })).toBe("banner");
  expect(chooseChannel({ hidden: true, enabled: true, permission: "default" })).toBe("banner");
  expect(chooseChannel({ hidden: true, enabled: true, permission: "unsupported" })).toBe("banner");
});
