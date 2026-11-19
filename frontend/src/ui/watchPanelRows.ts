import type { ScheduledFlight } from "../api/flightApi";
import { watchKey, type WatchedFlight } from "../watchlist";
import { NOTIFY_ENABLED, notificationPermission, showOsNotification } from "../notify/notifier";
import { notifyStateFor, setFlightEnabled } from "../notify/state";
import { h } from "./h";

/** Builders for watchPanel.ts: pure DOM fragments, no panel state. */

const timeOf = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Stockholm" }) : "–";

export function describe(f: ScheduledFlight): string {
  const est = f.estimated && f.estimated !== f.scheduled ? ` → est ${timeOf(f.estimated)}` : "";
  const gate = f.gate ? ` · gate ${f.gate}` : "";
  return `${f.direction === "arrivals" ? "arr" : "dep"} ${timeOf(f.scheduled)}${est}${gate} · ${f.status ?? "no status"}`;
}

export const routeOf = (f: ScheduledFlight): string => `${f.departureIata ?? "?"} → ${f.arrivalIata ?? "?"}`;

const PLANE_SVG =
  `<svg class="watch-panel-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 16v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5z"/></svg>`;

const BELL_SVG =
  '<svg viewBox="0 0 24 24"><path d="M12 22a2.2 2.2 0 0 0 2.2-2.2h-4.4A2.2 2.2 0 0 0 12 22zm7-5.2V11a7 7 0 0 0-5.2-6.8V3.5a1.8 1.8 0 0 0-3.6 0v.7A7 7 0 0 0 5 11v5.8L3.5 18v1h17v-1z"/></svg>';

/**
 * Static markup, the count is a number. The label and chevron show on desktop;
 * on a phone the button is a round icon like the search and favourites ones.
 */
export function renderToggle(toggle: HTMLElement, count: number, open: boolean): void {
  toggle.innerHTML =
    PLANE_SVG +
    `<span class="watch-panel-label">Watch${count ? ` (${count})` : ""} ${open ? "▲" : "▼"}</span>` +
    (count ? `<span class="watch-panel-count" aria-hidden="true">${count}</span>` : "");
  toggle.setAttribute("aria-label", `Watch flights${count ? `, ${count} watched` : ""}`);
  toggle.setAttribute("aria-expanded", String(open));
}

export interface ResultsOptions {
  results: ScheduledFlight[];
  watched: WatchedFlight[];
  date: string;
  onWatch: (f: ScheduledFlight) => void;
}

/** The search hits, each with a Watch button (disabled once watched). */
export function resultsList({ results, watched, date, onWatch }: ResultsOptions): HTMLElement {
  const list = h("ul", { className: "watch-panel-results" });
  for (const f of results) {
    const key = watchKey({ flightNumber: f.flightNumber, date, airport: f.airport });
    const already = watched.some((w) => watchKey(w) === key);
    list.appendChild(
      h("li", { className: "watch-panel-result" },
        h("span", { className: "watch-panel-name" }, `${f.flightNumber} ${routeOf(f)}`),
        h("span", { className: "watch-panel-detail" }, describe(f)),
        h("button", { type: "button", className: "watch-panel-watch", disabled: already, onClick: () => onWatch(f) }, already ? "Watching" : "Watch"),
      ),
    );
  }
  return list;
}

export interface WatchedRowOptions {
  w: WatchedFlight;
  flight: ScheduledFlight | null;
  notifyExpanded: boolean;
  onBell: () => void;
  onGoto: () => void;
  onRemove: () => void;
  notify: () => HTMLElement;
}

function bellIcon(): HTMLElement {
  const span = h("span", { className: "watch-panel-bell-icon", "aria-hidden": "true" });
  span.innerHTML = BELL_SVG;
  return span;
}

function bellButton(o: WatchedRowOptions): HTMLElement | null {
  if (!NOTIFY_ENABLED) return null;
  const notifyOn = !!notifyStateFor(watchKey(o.w)).enabled;
  return h(
    "button",
    {
      type: "button",
      className: `watch-panel-bell${notifyOn ? " watch-panel-bell--on" : ""}`,
      "aria-label": `Notifications for ${o.w.flightNumber}`,
      "aria-expanded": String(o.notifyExpanded),
      onClick: o.onBell,
    },
    bellIcon(),
  );
}

function gotoOrGround(o: WatchedRowOptions): HTMLElement {
  const airborne = !!(o.flight?.airborne && o.flight.icao24);
  return airborne
    ? h("button", { type: "button", className: "watch-panel-goto", onClick: o.onGoto }, "Go to")
    : h("span", { className: "watch-panel-ground" }, "not airborne yet");
}

/** One watched flight: name, schedule detail, Go to / bell / remove. */
export function watchedRow(o: WatchedRowOptions): HTMLElement {
  const { w, flight } = o;
  return h("li", { className: "watch-panel-item" },
    h("span", { className: "watch-panel-name" }, `${w.flightNumber} ${w.label} - ${w.date}`),
    h("span", { className: "watch-panel-detail" }, flight ? describe(flight) : "no data yet"),
    h("div", { className: "watch-panel-actions" },
      gotoOrGround(o),
      bellButton(o),
      h("button", { type: "button", className: "watch-panel-remove", "aria-label": `Stop watching ${w.flightNumber}`, onClick: o.onRemove }, "✕"),
    ),
    o.notifyExpanded ? o.notify() : null,
  );
}

type Permission = ReturnType<typeof notificationPermission>;

function notifyStatusLine(perm: Permission, enabled: boolean): string {
  if (perm === "unsupported") return "Notifications: not supported here";
  if (perm === "denied") return "Notifications: blocked in your browser — the in-app banner still works.";
  return enabled ? "Notifications: on" : "Notifications: not enabled for this flight";
}

export interface NotifyBlockOptions {
  w: WatchedFlight;
  /** Re-render the panel after a setting changed. */
  rerender: () => void;
  /** The "Notify me" click (may prompt for permission). */
  enable: (w: WatchedFlight) => void;
}

const notifyAction = (label: string, onClick: () => void): HTMLElement =>
  h("button", { type: "button", className: "watch-panel-notify-action", onClick }, label);

function notifyActions({ w, rerender, enable }: NotifyBlockOptions, perm: Permission, enabled: boolean): HTMLElement[] {
  const key = watchKey(w);
  if (!enabled) {
    return perm === "granted" || perm === "default" ? [notifyAction("Notify me", () => enable(w))] : [];
  }
  const actions = [notifyAction("Turn off", () => { setFlightEnabled(key, false); rerender(); })];
  if (perm === "granted") {
    actions.push(notifyAction("Send a test notification", () => { void showOsNotification("Netwatch Skygrid", `Test notification for ${w.flightNumber}.`, { key }); }));
  }
  return actions;
}

/** The consent copy and the permission states from #82 design §5. */
export function notifyBlock(o: NotifyBlockOptions): HTMLElement {
  const perm = notificationPermission();
  const enabled = !!notifyStateFor(watchKey(o.w)).enabled;
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent);
  const actions = notifyActions(o, perm, enabled);
  return h(
    "div",
    { className: "watch-panel-notify" },
    h("p", { className: "watch-panel-notify-copy" }, "Notifications appear while this site is open — a background tab is fine, a closed browser is not."),
    ios ? h("p", { className: "watch-panel-notify-copy" }, "On iPhone, add this site to your Home Screen first.") : null,
    h("p", { className: "watch-panel-notify-status" }, notifyStatusLine(perm, enabled)),
    actions.length ? h("div", { className: "watch-panel-notify-actions" }, ...actions) : null,
  );
}

/**
 * After the first scroll: keep the fresh entry pinned once its status row has
 * landed, checking again after the layout settles in case the text wrapped late.
 */
export function rescrollWhenSettled(target: HTMLElement, box: HTMLElement): void {
  requestAnimationFrame(() => {
    if (!target.isConnected) return;
    const itemBox = target.getBoundingClientRect();
    const panelBox = box.getBoundingClientRect();
    if (itemBox.bottom > panelBox.bottom + 1 || itemBox.top < panelBox.top - 1) {
      target.scrollIntoView({ block: "nearest" });
    }
  });
}

export interface SearchInput {
  flight: string;
  from: string;
  to: string;
  date: string;
}

/** The /api/schedule/search query for the form, or null when it is incomplete. */
export function searchQuery({ flight, from, to, date }: SearchInput): { flight?: string; from?: string; to?: string; date: string } | null {
  if (flight) return { flight, from: undefined, to: undefined, date };
  if (!from || !to) return null;
  return { flight: undefined, from, to, date };
}
