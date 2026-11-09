import type { FlightEvent, FlightNotifyState, NotifyMap } from "./types";

/** One watched flight's detector output for a poll: its advanced state and any event. */
export interface NotifyOutcome {
  key: string;
  state: FlightNotifyState;
  event: FlightEvent | null;
}

/**
 * Persists each flight's advanced state and announces its events.
 *
 * Every flight's state is written the moment it is known and *before* its own
 * event is announced, so the record of an announcement never depends on the
 * in-app banner (or the OS notification) running first. A reload therefore
 * always reads what the detector decided, whether or not the banner got to
 * draw (QA: "saving state should not depend on the banner order").
 */
export function commitNotifyPoll(opts: {
  poll: NotifyOutcome[];
  map: NotifyMap;
  save: (map: NotifyMap) => void;
  announce: (outcome: NotifyOutcome) => void;
}): void {
  for (const outcome of opts.poll) {
    opts.map[outcome.key] = outcome.state;
    opts.save(opts.map);
    if (outcome.event) opts.announce(outcome);
  }
}
