import type { AppStore } from "./state/appState";
import type { FlightPosition, LiveMarker } from "./types/flight";
import { saveWatched, watchKey, type WatchedFlight } from "./watchlist";
import { fetchFlightLive, searchScheduleWithStatus, type ScheduledFlight, type ScheduleStatus } from "./api/flightApi";
import { NOTIFY_ENABLED, notificationPermission, showOsNotification } from "./notify/notifier";
import { emptyState, forgetFlight, loadNotifyState, pruneNotifyState, saveNotifyState } from "./notify/state";
import { chooseChannel, observeFlight } from "./notify/detect";
import { commitNotifyPoll, type NotifyOutcome } from "./notify/poll";
import type { AsOfMarker } from "./map/asOf";

/**
 * The watched-flight background follow: the poll that resolves each watched
 * flight's schedule row on the same cheap Swedavia endpoint the Watch panel used
 * to poll (but only while it was open), follows each one that is airborne, and
 * raises the departure toast on the tick it leaves the ground.
 *
 * Inert at construction: nothing is fetched, timed or subscribed until
 * `startWatchPoll()`. Everything it needs from boot()'s closure - the store, the
 * viewport snapshot, the layer re-render and the selection - arrives through
 * deps as arrow callbacks, so this module keeps no import of main.ts.
 */
export interface WatchFollowDeps {
  store: AppStore;
  /** boot()'s viewport snapshot: a watched plane may already sit in it. */
  positions: () => Map<string, AsOfMarker>;
  renderAircraftLayer: () => void;
  selectAircraft: (marker: LiveMarker) => void;
}

export interface WatchFollow {
  /** icao24s of watched flights the last poll found airborne (the map draws them distinct). */
  watchedIcao24s: () => Set<string>;
  /**
   * The latest live position of each watched flight that is airborne, kept
   * apart from the viewport snapshot so the map highlight survives a refetch and
   * can sit outside the viewport's own data.
   */
  watchedLive: Map<string, AsOfMarker>;
  /** Start the background poll: one tick now, then on the Watch cadence, paused while the tab is hidden. */
  startWatchPoll: () => void;
  goToWatched: (w: WatchedFlight) => void;
  watchFlight: (w: WatchedFlight) => void;
  unwatchFlight: (w: WatchedFlight) => void;
  dismissDepartureToast: () => void;
  dismissWatchNotice: () => void;
}

/** One watched flight's schedule lookup, as a poll resolves it. */
type ScheduleEntry = readonly [key: string, row: ScheduledFlight | null, boardStatus: ScheduleStatus];

/** A row the notification detector gets to see on this poll. */
interface NotifySample {
  key: string;
  row: ScheduledFlight;
  boardStatus: ScheduleStatus;
}

/** What one poll pass accumulates, so the pass can be split a case at a time. */
interface PollAccumulator {
  status: Record<string, ScheduledFlight | null>;
  airborneNow: Set<string>;
  positionsNow: Map<string, FlightPosition | null>;
  fetches: Promise<void>[];
  departed: WatchedFlight[];
  notifySamples: NotifySample[];
}

export function createWatchFollow({ store, positions, renderAircraftLayer, selectAircraft }: WatchFollowDeps): WatchFollow {
  // The latest live position of each watched flight that is airborne, kept
  // apart from `positions` (a viewport snapshot) so the map highlight survives
  // a refetch and can sit outside the viewport's own data.
  const watchedLive = new Map<string, AsOfMarker>();
  // The airborne state seen last poll, per watchKey, so a departure is a
  // transition (false -> true), not merely "airborne".
  const watchedAirborne = new Map<string, boolean>();
  let watchTimer: ReturnType<typeof setInterval> | null = null;
  let watchGen = 0;
  const WATCH_POLL_MS = 60_000;

  /** icao24s of watched flights the last poll found airborne (the map draws them distinct). */
  function watchedIcao24s(): Set<string> {
    const out = new Set<string>();
    const status = store.get("watchedStatus");
    for (const key of Object.keys(status)) {
      const row = status[key];
      if (row?.airborne && row.icao24) out.add(row.icao24);
    }
    return out;
  }

  /** Resolve every watched flight's schedule row; a lookup that fails keeps the row it already had. */
  function resolveSchedule(list: WatchedFlight[], prev: Record<string, ScheduledFlight | null>): Promise<ScheduleEntry[]> {
    return Promise.all(
      list.map(async (w) => {
        try {
          const { rows, status } = await searchScheduleWithStatus({ flight: w.flightNumber, date: w.date, airport: w.airport });
          return [watchKey(w), rows.find((r) => r.airport === w.airport) ?? null, status] as const;
        } catch {
          return [watchKey(w), prev[watchKey(w)] ?? null, "incomplete"] as const;
        }
      }),
    );
  }

  function newPollAccumulator(): PollAccumulator {
    return {
      status: {},
      airborneNow: new Set<string>(),
      positionsNow: new Map<string, FlightPosition | null>(),
      fetches: [],
      departed: [],
      notifySamples: [],
    };
  }

  /** Apply one resolved row: its status, its airborne transition, its position and its notice sample. */
  function applyEntry(acc: PollAccumulator, [key, row, boardStatus]: ScheduleEntry, list: WatchedFlight[]): void {
    acc.status[key] = row;
    const air = !!(row && row.airborne && row.icao24);
    const was = watchedAirborne.get(key);
    watchedAirborne.set(key, air);
    collectPosition(acc, row?.icao24 ?? null, air);
    if (isDeparture(air, was)) collectDeparture(acc, key, list);
    if (NOTIFY_ENABLED && row) acc.notifySamples.push({ key, row, boardStatus });
  }

  /** Keep the flight's live position: a watched plane is drawn from it, even outside the viewport. */
  function collectPosition(acc: PollAccumulator, icao24: string | null, air: boolean): void {
    // With the notify flag off, keep the request pattern exactly as it was
    // before this slice: fetch a flight's live position only while it is
    // airborne. The extra fetch for a not-yet-airborne flight exists only to
    // feed the notification detector (the on-ground ticks that prove a
    // landing), so it is gated on the flag instead of being paid for by every
    // default build.
    if (!icao24) return;
    if (!air && !NOTIFY_ENABLED) return;
    if (air) acc.airborneNow.add(icao24);
    acc.fetches.push(
      fetchFlightLive(icao24)
        .then((p) => {
          acc.positionsNow.set(icao24, p);
          if (p && air) watchedLive.set(icao24, { ...p, asOf: Date.now() });
        })
        .catch(() => {
          acc.positionsNow.set(icao24, null);
        }),
    );
  }

  /** A departure: the tick a watched flight's airborne state went from "no" to "yes". */
  function isDeparture(air: boolean, was: boolean | undefined): boolean {
    if (!air) return false;
    return was === false;
  }

  /** Keep the flight whose watchKey this is, as a departure the toast waits on. */
  function collectDeparture(acc: PollAccumulator, key: string, list: WatchedFlight[]): void {
    const w = list.find((x) => watchKey(x) === key);
    if (w) acc.departed.push(w);
  }

  /** A flight no longer airborne: drop the position we kept for it. */
  function dropStaleLive(airborneNow: Set<string>): void {
    for (const icao24 of Array.from(watchedLive.keys())) if (!airborneNow.has(icao24)) watchedLive.delete(icao24);
  }

  /** Publish the poll's result to the store and the map, then raise its notices. */
  function publish(acc: PollAccumulator, list: WatchedFlight[]): void {
    dropStaleLive(acc.airborneNow);
    store.set("watchedStatus", acc.status);
    renderAircraftLayer();

    if (NOTIFY_ENABLED) pollNotifications(acc, list);
    else if (acc.departed.length > 0) store.set("departureToast", acc.departed[0]);
  }

  /** Run this poll's samples through the detector and commit what each flight's state became. */
  function pollNotifications(acc: PollAccumulator, list: WatchedFlight[]): void {
    const notifyMap = loadNotifyState();
    const poll: NotifyOutcome[] = [];
    for (const sample of acc.notifySamples) poll.push(detectSample(sample, acc, notifyMap));
    // The state is persisted per flight, before its event is announced, so
    // the record never depends on the banner drawing (commitNotifyPoll).
    commitNotifyPoll({
      poll,
      map: notifyMap,
      save: (map) => saveNotifyState(pruneNotifyState(map)),
      announce: (outcome) => announce(outcome, list),
    });
  }

  /** One flight's sample through the detector, against the state it carried into this poll. */
  function detectSample(sample: NotifySample, acc: PollAccumulator, notifyMap: ReturnType<typeof loadNotifyState>): NotifyOutcome {
    const position = sample.row.icao24 ? acc.positionsNow.get(sample.row.icao24) ?? null : null;
    const prior = notifyMap[sample.key] ?? emptyState();
    const { state, event } = observeFlight(prior, { ...sample, position, nowMs: Date.now() });
    return { key: sample.key, state, event };
  }

  /** Announce one event on the channel that fits: the OS, or the in-app notice. */
  function announce(outcome: NotifyOutcome, list: WatchedFlight[]): void {
    const { event } = outcome;
    if (!event) return;
    const flight = list.find((x) => watchKey(x) === outcome.key);
    if (!flight) return;
    const channel = chooseChannel({ hidden: document.hidden, enabled: outcome.state.enabled, permission: notificationPermission() });
    if (channel === "os") {
      void showOsNotification(event.title, event.text, { key: event.key, kind: event.kind });
    } else {
      store.set("watchNotice", { flight, text: event.text, kind: event.kind });
    }
  }

  /**
   * Polls every watched flight on the same cheap Swedavia endpoint the Watch
   * panel used to poll (but only while it was open), follows each one that is
   * airborne, and raises the departure toast on the tick it leaves the ground.
   * Runs for the whole session, paused while the tab is hidden.
   */
  async function pollWatched(): Promise<void> {
    const gen = ++watchGen;
    const list = store.get("watchedFlights");
    const prev = store.get("watchedStatus");
    const entries = await resolveSchedule(list, prev);
    if (gen !== watchGen) return;
    const acc = newPollAccumulator();
    for (const entry of entries) applyEntry(acc, entry, list);
    await Promise.all(acc.fetches);
    if (gen !== watchGen) return;
    publish(acc, list);
  }

  function onVisibility(): void {
    if (!document.hidden) void pollWatched();
  }

  function startWatchPoll(): void {
    if (watchTimer) clearInterval(watchTimer);
    watchTimer = setInterval(() => {
      if (!document.hidden) void pollWatched();
    }, WATCH_POLL_MS);
    document.addEventListener("visibilitychange", onVisibility);
    void pollWatched();
  }

  /** Select the watched flight's plane and fly the map to it. No-op until it is airborne. */
  function goToWatched(w: WatchedFlight): void {
    const row = store.get("watchedStatus")[watchKey(w)] ?? null;
    if (!row?.airborne || !row.icao24) return;
    const icao24 = row.icao24;
    const known = watchedLive.get(icao24) ?? positions().get(icao24);
    if (known) {
      selectAircraft(known);
      return;
    }
    fetchFlightLive(icao24)
      .then((p) => {
        if (!p) return;
        watchedLive.set(icao24, { ...p, asOf: Date.now() });
        selectAircraft(p);
        renderAircraftLayer();
      })
      .catch(() => {});
  }

  function watchFlight(w: WatchedFlight): void {
    const list = store.get("watchedFlights");
    if (list.some((x) => watchKey(x) === watchKey(w))) return;
    const next = [...list, w];
    saveWatched(next);
    store.set("watchedFlights", next);
    void pollWatched(); // resolve its schedule row now, not on the next tick
  }

  function unwatchFlight(w: WatchedFlight): void {
    const key = watchKey(w);
    const next = store.get("watchedFlights").filter((x) => watchKey(x) !== key);
    saveWatched(next);
    const status = { ...store.get("watchedStatus") };
    delete status[key];
    store.set("watchedStatus", status);
    watchedAirborne.delete(key);
    if (NOTIFY_ENABLED) forgetFlight(key);
    store.set("watchedFlights", next);
  }

  function dismissDepartureToast(): void {
    store.set("departureToast", null);
  }

  function dismissWatchNotice(): void {
    store.set("watchNotice", null);
  }

  return {
    watchedIcao24s,
    watchedLive,
    startWatchPoll,
    goToWatched,
    watchFlight,
    unwatchFlight,
    dismissDepartureToast,
    dismissWatchNotice,
  };
}
