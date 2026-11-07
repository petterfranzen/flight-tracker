import type { AppStore } from "../state/appState";
import { searchSchedule, type ScheduledFlight } from "../api/flightApi";
import { watchKey, type WatchedFlight } from "../watchlist";
import { h, clear } from "./h";
import "../components/WatchPanel.css";

const timeOf = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Stockholm" }) : "–";

function describe(f: ScheduledFlight): string {
  const est = f.estimated && f.estimated !== f.scheduled ? ` → est ${timeOf(f.estimated)}` : "";
  const gate = f.gate ? ` · gate ${f.gate}` : "";
  return `${f.direction === "arrivals" ? "arr" : "dep"} ${timeOf(f.scheduled)}${est}${gate} · ${f.status ?? "no status"}`;
}

const routeOf = (f: ScheduledFlight): string => `${f.departureIata ?? "?"} → ${f.arrivalIata ?? "?"}`;

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
  // Set when a watch is added, so the next render brings its row into the
  // panel's own scroll box (the list is chronological: newest is last).
  let pendingScrollKey: string | null = null;

  const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Stockholm" });
  const flightInput = h("input", { type: "text", className: "watch-panel-flight", placeholder: "Flight, e.g. BA778", "aria-label": "Flight number" });
  const fromInput = h("input", { type: "text", className: "watch-panel-from", placeholder: "From, e.g. LHR,LGW", "aria-label": "From airports" });
  const toInput = h("input", { type: "text", className: "watch-panel-to", placeholder: "To, e.g. ARN", "aria-label": "To airports" });
  const dateInput = h("input", { type: "date", className: "watch-panel-date", value: today, "aria-label": "Date" });

  function render(): void {
    // Static markup, the count is a number. The label and chevron show on desktop;
    // on a phone the button is a round icon like the search and favourites ones.
    toggle.innerHTML =
      `<svg class="watch-panel-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 16v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5z"/></svg>` +
      `<span class="watch-panel-label">Watch${watched.length ? ` (${watched.length})` : ""} ${open ? "\u25b2" : "\u25bc"}</span>` +
      (watched.length ? `<span class="watch-panel-count" aria-hidden="true">${watched.length}</span>` : "");
    toggle.setAttribute("aria-label", `Watch flights${watched.length ? `, ${watched.length} watched` : ""}`);
    toggle.setAttribute("aria-expanded", String(open));
    content.hidden = !open;
    if (!open) return;
    clear(dyn);
    if (message) dyn.appendChild(h("p", { className: "watch-panel-message" }, message));

    if (results.length) {
      const list = h("ul", { className: "watch-panel-results" });
      for (const f of results) {
        const already = watched.some((w) => watchKey(w) === watchKey({ flightNumber: f.flightNumber, date: dateInput.value, airport: f.airport }));
        list.appendChild(
          h("li", { className: "watch-panel-result" },
            h("span", { className: "watch-panel-name" }, `${f.flightNumber} ${routeOf(f)}`),
            h("span", { className: "watch-panel-detail" }, describe(f)),
            h("button", { type: "button", className: "watch-panel-watch", disabled: already, onClick: () => watch(f) }, already ? "Watching" : "Watch"),
          ),
        );
      }
      dyn.appendChild(list);
    }

    if (watched.length) {
      dyn.appendChild(h("div", { className: "watch-panel-heading" }, "Watched flights"));
      const list = h("ul", { className: "watch-panel-watched" });
      let scrollTarget: HTMLElement | null = null;
      for (const w of watched) {
        const f = status[watchKey(w)] ?? null;
        const airborne = !!(f && f.airborne && f.icao24);
        const item = h("li", { className: "watch-panel-item" },
          h("span", { className: "watch-panel-name" }, `${w.flightNumber} ${w.label} - ${w.date}`),
          h("span", { className: "watch-panel-detail" }, f ? describe(f) : "no data yet"),
          airborne
            ? h("button", { type: "button", className: "watch-panel-goto", onClick: () => goto(w) }, "Go to")
            : h("span", { className: "watch-panel-ground" }, "not airborne yet"),
          h("button", { type: "button", className: "watch-panel-remove", "aria-label": `Stop watching ${w.flightNumber}`, onClick: () => store.get("unwatchFlight")(w) }, "\u2715"),
        );
        if (pendingScrollKey && watchKey(w) === pendingScrollKey) scrollTarget = item;
        list.appendChild(item);
      }
      dyn.appendChild(list);
      if (scrollTarget) {
        pendingScrollKey = null;
        // "nearest": scrolls the panel's own box, not the page, and does
        // nothing on desktop where the list already fits.
        scrollTarget.scrollIntoView({ block: "nearest" });
      }
    }
  }

  async function search(): Promise<void> {
    const flight = flightInput.value.trim();
    const from = fromInput.value.trim();
    const to = toInput.value.trim();
    if (!flight && !(from && to)) {
      message = "Enter a flight number, or both From and To";
      return render();
    }
    message = "Searching\u2026";
    render();
    try {
      results = await searchSchedule({ flight: flight || undefined, from: flight ? undefined : from, to: flight ? undefined : to, date: dateInput.value });
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
  function goto(w: WatchedFlight): void {
    store.get("goToWatched")(w);
    if (window.matchMedia("(max-width: 768px)").matches) setOpen(false);
  }

  const form = h(
    "form",
    { className: "watch-panel-form", onSubmit: (e: Event) => { e.preventDefault(); void search(); } },
    flightInput, h("div", { className: "watch-panel-or" }, "or route"), fromInput, toInput, dateInput,
    h("button", { type: "submit", className: "watch-panel-search" }, "Search"),
  );
  const dyn = h("div"); // everything below the form, rebuilt on each render (the form keeps focus)
  const toggle = h("button", { type: "button", className: "watch-panel-toggle", onClick: () => setOpen(!open) });
  const content = h("div", { className: "watch-panel-content" }, form, dyn);
  const container = h("div", { className: "watch-panel" }, toggle, content);
  root.appendChild(container);

  function setOpen(next: boolean): void {
    open = next;
    render();
  }

  const unsubscribe = store.subscribeMany(["watchedFlights", "watchedStatus"], () => {
    watched = store.get("watchedFlights");
    status = store.get("watchedStatus");
    render();
  });

  render();
  return () => {
    unsubscribe();
    container.remove();
  };
}
