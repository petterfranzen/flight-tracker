import type { AppStore } from "../state/appState";
import { fetchFlightLive, searchSchedule, type ScheduledFlight } from "../api/flightApi";
import { loadWatched, saveWatched, watchKey, type WatchedFlight } from "../watchlist";
import { h, clear } from "./h";
import "../components/WatchPanel.css";

const REFRESH_INTERVAL_MS = 60_000;

const timeOf = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Stockholm" }) : "–";

function describe(f: ScheduledFlight): string {
  const est = f.estimated && f.estimated !== f.scheduled ? ` → est ${timeOf(f.estimated)}` : "";
  const gate = f.gate ? ` · gate ${f.gate}` : "";
  return `${f.direction === "arrivals" ? "arr" : "dep"} ${timeOf(f.scheduled)}${est}${gate} · ${f.status ?? "no status"}`;
}

const routeOf = (f: ScheduledFlight): string => `${f.departureIata ?? "?"} → ${f.arrivalIata ?? "?"}`;

/**
 * Find a flight before it flies (Swedavia boards, via /api/schedule/search), "Watch" it, and follow it:
 * each watched flight polls the same endpoint every minute while the panel is open, and once the server
 * has matched it to a live aircraft, a button selects that plane on the map.
 */
export function mount(root: HTMLElement, store: AppStore): () => void {
  let open = false;
  let watched = loadWatched();
  let results: ScheduledFlight[] = [];
  let message = "";
  const latest = new Map<string, ScheduledFlight | null>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let generation = 0;

  const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Stockholm" });
  const flightInput = h("input", { type: "text", className: "watch-panel-flight", placeholder: "Flight, e.g. BA778", "aria-label": "Flight number" });
  const fromInput = h("input", { type: "text", className: "watch-panel-from", placeholder: "From, e.g. LHR,LGW", "aria-label": "From airports" });
  const toInput = h("input", { type: "text", className: "watch-panel-to", placeholder: "To, e.g. ARN", "aria-label": "To airports" });
  const dateInput = h("input", { type: "date", className: "watch-panel-date", value: today, "aria-label": "Date" });

  async function refresh(): Promise<void> {
    const gen = ++generation;
    const entries = await Promise.all(
      watched.map(async (w) => {
        try {
          const rows = await searchSchedule({ flight: w.flightNumber, date: w.date, airport: w.airport });
          return [watchKey(w), rows.find((r) => r.airport === w.airport) ?? null] as const;
        } catch {
          return [watchKey(w), latest.get(watchKey(w)) ?? null] as const;
        }
      }),
    );
    if (gen !== generation) return;
    for (const [k, v] of entries) latest.set(k, v);
    render();
  }

  function setOpen(next: boolean): void {
    open = next;
    if (timer) clearInterval(timer);
    timer = null;
    if (open) {
      void refresh();
      timer = setInterval(refresh, REFRESH_INTERVAL_MS);
    } else generation++;
    render();
  }

  async function search(): Promise<void> {
    const flight = flightInput.value.trim();
    const from = fromInput.value.trim();
    const to = toInput.value.trim();
    if (!flight && !(from && to)) {
      message = "Enter a flight number, or both From and To";
      return render();
    }
    message = "Searching…";
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
    if (watched.some((x) => watchKey(x) === watchKey(w))) return;
    watched = [...watched, w];
    saveWatched(watched);
    latest.set(watchKey(w), f);
    render();
  }

  function unwatch(w: WatchedFlight): void {
    watched = watched.filter((x) => watchKey(x) !== watchKey(w));
    saveWatched(watched);
    render();
  }

  async function show(icao24: string): Promise<void> {
    const p = await fetchFlightLive(icao24).catch(() => null);
    if (!p) return;
    store.get("selectAircraft")(p);
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

  function render(): void {
    // Static markup, the count is a number. The label and chevron show on desktop;
    // on a phone the button is a round icon like the search and favourites ones.
    toggle.innerHTML =
      `<svg class="watch-panel-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 16v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5z"/></svg>` +
      `<span class="watch-panel-label">Watch${watched.length ? ` (${watched.length})` : ""} ${open ? "▲" : "▼"}</span>` +
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
      for (const w of watched) {
        const f = latest.get(watchKey(w)) ?? null;
        const airborne = !!(f && f.airborne && f.icao24);
        list.appendChild(
          h("li", { className: "watch-panel-item" },
            h("span", { className: "watch-panel-name" }, `${w.flightNumber} ${w.label} · ${w.date}`),
            h("span", { className: "watch-panel-detail" }, f ? describe(f) : "no data yet"),
            airborne
              ? h("button", { type: "button", className: "watch-panel-show", onClick: () => void show(f!.icao24!) }, "Airborne — show on map")
              : h("span", { className: "watch-panel-ground" }, "not airborne yet"),
            h("button", { type: "button", className: "watch-panel-remove", "aria-label": `Stop watching ${w.flightNumber}`, onClick: () => unwatch(w) }, "✕"),
          ),
        );
      }
      dyn.appendChild(list);
    }
  }

  render();
  return () => {
    if (timer) clearInterval(timer);
    container.remove();
  };
}
