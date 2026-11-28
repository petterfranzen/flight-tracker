import type { AppStore } from "../state/appState";
import { searchSchedule, type ScheduledFlight } from "../api/flightApi";
import { watchKey, type WatchedFlight } from "../watchlist";
import { notificationPermission, requestNotificationPermission } from "../notify/notifier";
import { setFlightEnabled } from "../notify/state";
import { h, clear } from "./h";
import { notifyBlock, renderToggle, rescrollWhenSettled, resultsList, routeOf, searchQuery, watchedRow } from "./watchPanelRows";
import { activateModal, closeOnEscape, isPhone, modalOpen, type ModalHandle } from "./a11y";
import { closeControlPanel, registerControlPanel, toggleControlPanel } from "./controlStack";
import "../components/WatchPanel.css";
import "../components/ControlPanel.css";

/**
 * Find a flight before it flies (Swedavia boards, via /api/schedule/search) and
 * "Watch" it. The watch list itself lives in the store (state/appState.ts), so
 * the map highlight, the search box chips and the departure toast all read the
 * same list and the same freshly-polled schedule rows; this panel is just one
 * view of it, and its "Go to" action works whether or not the panel is open.
 */
export function mount(root: HTMLElement, store: AppStore): () => void {
  let open = false;
  let results: ScheduledFlight[] = [];
  let message = "";
  let watched: WatchedFlight[] = store.get("watchedFlights");
  let status: Record<string, ScheduledFlight | null> = store.get("watchedStatus");
  // Which row's notification block is expanded; null when none is.
  let notifyOpen: string | null = null;
  // Set when a watch is added, so the next render brings its row into the
  // panel's own scroll box (the list is chronological: newest is last).
  let pendingScrollKey: string | null = null;
  // The phone panel is modal like the other three (#183): focus in, Tab
  // trapped, Escape closes, focus returns to the ✈ button. Desktop is inline.
  let trap: ModalHandle | null = null;

  const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Stockholm" });
  const flightInput = h("input", { type: "text", className: "watch-panel-flight", placeholder: "Flight, e.g. BA778", "aria-label": "Flight number" });
  const fromInput = h("input", { type: "text", className: "watch-panel-from", placeholder: "From, e.g. LHR,LGW", "aria-label": "From airports" });
  const toInput = h("input", { type: "text", className: "watch-panel-to", placeholder: "To, e.g. ARN", "aria-label": "To airports" });
  const dateInput = h("input", { type: "date", className: "watch-panel-date", value: today, "aria-label": "Date" });

  function render(): void {
    renderToggle(toggle, watched.length, open);
    content.classList.toggle("control-panel--open", open);
    content.hidden = !open;
    syncModal();
    if (!open) return;
    clear(dyn);
    if (messageEl.textContent !== message) messageEl.textContent = message;
    if (results.length) dyn.appendChild(resultsList({ results, watched, date: dateInput.value, onWatch: watch }));
    if (watched.length) renderWatched();
  }

  function renderWatched(): void {
    dyn.appendChild(h("div", { className: "watch-panel-heading" }, "Watched flights"));
    const list = h("ul", { className: "watch-panel-watched" });
    let scrollTarget: HTMLElement | null = null;
    for (const w of watched) {
      const item = watchedItem(w);
      if (pendingScrollKey && watchKey(w) === pendingScrollKey) scrollTarget = item;
      list.appendChild(item);
    }
    dyn.appendChild(list);
    if (scrollTarget) scrollToNew(scrollTarget);
  }

  function watchedItem(w: WatchedFlight): HTMLElement {
    const key = watchKey(w);
    return watchedRow({
      w,
      flight: status[key] ?? null,
      notifyExpanded: notifyOpen === key,
      onBell: () => {
        notifyOpen = notifyOpen === key ? null : key;
        render();
      },
      onGoto: () => goto(w),
      onRemove: () => store.get("unwatchFlight")(w),
      notify: () => notifyBlock({ w, rerender: render, enable: (f) => void enableNotifications(f) }),
    });
  }

  function scrollToNew(target: HTMLElement): void {
    // "nearest": scrolls the panel's own box, not the page, and does
    // nothing on desktop where the list already fits.
    target.scrollIntoView({ block: "nearest" });
    // One scroll is not enough. The row grows a line once the poll fills
    // its schedule detail (and swaps "not airborne yet" for "Go to"), which
    // clips the taller row at the panel's edge. Keep the fresh entry pinned
    // until its status row lands, re-scrolling on that render, then check
    // once more after the layout settles in case the text wrapped late.
    if (pendingScrollKey && pendingScrollKey in status) {
      pendingScrollKey = null;
      rescrollWhenSettled(target, content);
    }
  }

  /** The bell's "Notify me" click: the only place a permission prompt appears. */
  async function enableNotifications(w: WatchedFlight): Promise<void> {
    let perm = notificationPermission();
    if (perm === "default") perm = await requestNotificationPermission();
    if (perm === "granted") setFlightEnabled(watchKey(w), true);
    render();
  }

  async function search(): Promise<void> {
    const query = searchQuery({ flight: flightInput.value.trim(), from: fromInput.value.trim(), to: toInput.value.trim(), date: dateInput.value });
    if (!query) {
      message = "Enter a flight number, or both From and To";
      return render();
    }
    message = "Searching\u2026";
    render();
    try {
      results = await searchSchedule(query);
      message = results.length ? "" : "No matching flights on a Swedavia board";
    } catch (e) {
      results = [];
      message = e instanceof Error ? e.message : "Search failed";
    }
    render();
  }

  function watch(f: ScheduledFlight): void {
    const w: WatchedFlight = { flightNumber: f.flightNumber, date: dateInput.value, airport: f.airport, label: routeOf(f) };
    // The watched list is chronological (newest last), so the new entry can
    // land below the panel's scroll box; bring it into view once rendered.
    pendingScrollKey = watchKey(w);
    store.get("watchFlight")(w);
  }

  // On mobile the open panel covers the map: moving the map to the plane should
  // not leave the user staring at the list.
  // Closes first so the selection's focus move to the dossier (#421) is not undone by the drawer handing focus back.
  function goto(w: WatchedFlight): void {
    if (isPhone()) closeControlPanel("watch");
    store.get("goToWatched")(w);
  }

  const form = h(
    "form",
    { className: "watch-panel-form", onSubmit: (e: Event) => { e.preventDefault(); void search(); } },
    flightInput, h("div", { className: "watch-panel-or" }, "or route"), fromInput, toInput, dateInput,
    h("button", { type: "submit", className: "watch-panel-search" }, "Search"),
  );
  // role=status: a polite announcement of "Searching…", "No matching flights…", a search error.
  // One element from mount whose text changes (#421): a live region inserted with its text is often missed.
  const messageEl = h("p", { className: "watch-panel-message", role: "status" });
  const dyn = h("div"); // everything below the form, rebuilt on each render (the form keeps focus)
  const toggle = h("button", { type: "button", className: "watch-panel-toggle control-stack-button", onClick: () => toggleControlPanel("watch") });
  const closeButton = h("button", { type: "button", className: "watch-panel-close control-panel-close", onClick: () => closeControlPanel("watch") }, "Close watch ✕");
  const content = h("div", { className: "watch-panel-content control-panel" }, closeButton, form, messageEl, dyn);
  const container = h("div", { className: "watch-panel" }, toggle, content);
  root.appendChild(container);

  function setOpen(next: boolean): void {
    open = next;
    render();
  }

  /** See flightSearch.ts's syncModal — same modal-on-phone treatment. */
  function syncModal(): void {
    const modal = open && isPhone();
    if (modal && !trap) {
      content.setAttribute("role", "dialog");
      content.setAttribute("aria-modal", "true");
      content.setAttribute("aria-label", "Watch flights");
      trap = activateModal(content, { onEscape: () => closeControlPanel("watch"), returnTo: toggle });
    } else if (!modal && trap) {
      trap.release();
      trap = null;
      content.removeAttribute("role");
      content.removeAttribute("aria-modal");
      content.removeAttribute("aria-label");
    }
  }

  const unsubscribe = store.subscribeMany(["watchedFlights", "watchedStatus"], () => {
    watched = store.get("watchedFlights");
    status = store.get("watchedStatus");
    render();
  });

  // Escape closes the open panel (not a modal — Tab is not trapped). Skips
  // while a modal overlay is open, so one keypress does not close both.
  const detachEscape = closeOnEscape(() => {
    if (modalOpen()) return;
    if (open) closeControlPanel("watch");
  });

  render();
  const unregister = registerControlPanel("watch", {
    panel: content,
    button: toggle,
    open: () => setOpen(true),
    close: () => setOpen(false),
  });
  return () => {
    unregister();
    trap?.release();
    trap = null;
    unsubscribe();
    detachEscape();
    container.remove();
  };
}
