import { expect, test } from "@playwright/test";
import { commitNotifyPoll, type NotifyOutcome } from "../src/notify/poll";
import { emptyState, startHourlyPrune } from "../src/notify/state";
import type { FlightEvent, NotifyMap } from "../src/notify/types";

// The poll plumbing (#82 design §2): the hourly prune's lifetime, and the order
// in which an event's state is persisted against being announced. Pure: no
// page, no map, no network, so it runs in one second on any box.

const HOUR_MS = 60 * 60 * 1000;

const event = (kind: FlightEvent["kind"]): FlightEvent => ({
  key: "SK2112|2026-11-02|ARN",
  kind,
  title: "SK2112",
  text: `SK2112 ${kind}`,
  row: { flightNumber: "SK2112", airport: "ARN" } as FlightEvent["row"],
  nowMs: 1_762_000_000_000,
});

test("the hourly prune runs on start, once an hour, and its disposer clears the timer", () => {
  const writes: string[] = [];
  const intervals: { fn: () => void; ms: number; id: number }[] = [];
  let cleared: number | null = null;
  let nextId = 1;
  const g = globalThis as unknown as Record<string, unknown>;
  const realLocalStorage = g.localStorage;
  const realSetInterval = g.setInterval;
  const realClearInterval = g.clearInterval;
  // A recording localStorage: the prune is observable through the write it makes.
  g.localStorage = { getItem: () => null, setItem: (_k: string, v: string) => writes.push(v), removeItem: () => {} };
  g.setInterval = (fn: () => void, ms: number) => {
    const id = nextId++;
    intervals.push({ fn, ms, id });
    return id;
  };
  g.clearInterval = (id: number) => {
    cleared = id;
  };
  try {
    const stop = startHourlyPrune();
    expect(writes).toHaveLength(1); // pruned on load
    expect(intervals).toHaveLength(1); // and scheduled hourly
    expect(intervals[0].ms).toBe(HOUR_MS);

    intervals[0].fn(); // the tick prunes again
    expect(writes).toHaveLength(2);

    stop(); // pagehide: the interval must not outlive the page
    expect(cleared).toBe(intervals[0].id);
  } finally {
    g.localStorage = realLocalStorage;
    g.setInterval = realSetInterval;
    g.clearInterval = realClearInterval;
  }
});

test("each flight's state is saved before its own event is announced", () => {
  const log: string[] = [];
  const map: NotifyMap = {};
  const a: NotifyOutcome = { key: "A", state: { ...emptyState(), airborne: true }, event: event("takeoff") };
  const b: NotifyOutcome = { key: "B", state: { ...emptyState(), onGroundStreak: 1 }, event: null };
  commitNotifyPoll({
    poll: [a, b],
    map,
    save: (m) => log.push(`save:${Object.keys(m).sort().join("+")}`),
    announce: (o) => log.push(`announce:${o.key}`),
  });
  // The write for A lands before A is announced; B (no event) is still saved.
  // Saving once after the announce loop would read announce:A then save:A+B.
  expect(log).toEqual(["save:A", "announce:A", "save:A+B"]);
});

test("an announcement that throws still leaves that event's state saved", () => {
  const map: NotifyMap = {};
  let saves = 0;
  expect(() =>
    commitNotifyPoll({
      poll: [{ key: "A", state: emptyState(), event: event("landed") }],
      map,
      save: () => {
        saves++;
      },
      announce: () => {
        throw new Error("the banner blew up");
      },
    }),
  ).toThrow("the banner blew up");
  // Saving after the announce loop would leave this at 0 and lose the record.
  expect(saves).toBe(1);
  expect(map.A).toBeDefined();
});
