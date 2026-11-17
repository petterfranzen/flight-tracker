import type { AppStore } from "../state/appState";
import type { FlightPosition } from "../types/flight";
import { searchFlights, searchFlightsByAirport, type ScheduledFlight } from "../api/flightApi";
import { watchKey, watchedMatchesQuery, type WatchedFlight } from "../watchlist";
import { h, clear } from "./h";
import { activateModal, isPhone, type ModalHandle } from "./a11y";
import { closeControlPanel, registerControlPanel, toggleControlPanel } from "./controlStack";
import { SearchBox } from "./searchBox";
import "../components/FlightSearch.css";
import "../components/ControlPanel.css";

function searchIconSvg(): SVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.innerHTML =
    '<path d="M15.5 14h-.79l-.28-.27a6.5 6.5 0 1 0-.7.7l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9z" fill="currentColor" />';
  return svg;
}

/** A watched flight's schedule row says it is in the air, on a known aircraft. */
function isAirborne(row: ScheduledFlight | null): boolean {
  return !!(row?.airborne && row.icao24);
}

/** One chip of the compact watched list under the search box. */
function watchedChip(w: WatchedFlight, airborne: boolean, onClick: () => void): HTMLElement {
  return h(
    "button",
    {
      type: "button",
      className: `flight-search-chip${airborne ? " flight-search-chip--airborne" : ""}`,
      title: airborne ? `Go to ${w.flightNumber}` : `${w.flightNumber} · not airborne yet`,
      onClick,
    },
    h("span", { className: "flight-search-chip-dot", "aria-hidden": "true" }),
    w.flightNumber,
  );
}

/** A watched flight listed first in the results; `onClick` is only set while it is airborne. */
function watchedRow(w: WatchedFlight, airborne: boolean, onClick: () => void): HTMLElement {
  return h(
    "li",
    {
      className: `flight-search-option flight-search-option--watched${airborne ? " flight-search-option--airborne" : ""}`,
      role: "option",
      "aria-selected": "false",
      onMousedown: (e: MouseEvent) => e.preventDefault(),
      onClick,
    },
    h("span", { className: "flight-search-callsign" }, w.flightNumber),
    h("span", { className: "flight-search-watched-status" }, airborne ? `${w.label} · airborne` : `${w.label} · not airborne yet`),
  );
}

const PANEL_MODAL_ATTRS: Record<string, string> = { role: "dialog", "aria-modal": "true", "aria-label": "Search flights" };

/**
 * Two independent search modes sharing one component: the flight-number/
 * callsign box and, right under it, an airport box (both always visible).
 * Both funnel into `selectAircraft`. Kept
 * fully self-contained (no store slots) — nothing outside this module ever
 * needs to know its query/open state, same as the original React version.
 */
export function mount(root: HTMLElement, store: AppStore): () => void {
  function choose(p: FlightPosition): void {
    store.get("selectAircraft")(p);
    flightBox.reset();
    airportBox.reset();
    closeControlPanel("search");
    input.value = "";
    airportInput.value = "";
    renderAll();
  }

  function onEscape(): void {
    closeControlPanel("search");
    renderAll();
  }

  let mobilePanelOpen = false;
  // The phone overlay is modal: focus is trapped in it and returned to the FAB
  // on close (see a11y.ts). Null while the panel is closed or on desktop.
  let trap: ModalHandle | null = null;

  // --- watched flights: chips under the box, and listed first in the results ---
  let watched: WatchedFlight[] = store.get("watchedFlights");
  let watchedStatus: Record<string, ScheduledFlight | null> = store.get("watchedStatus");

  function goToWatched(w: WatchedFlight): void {
    store.get("goToWatched")(w);
  }

  // --- DOM ---
  // The primary flight-number/callsign box.
  const flightBox = new SearchBox({
    inputAttrs: {
      type: "text",
      inputMode: "search",
      className: "flight-search-input",
      placeholder: "Search by flight number…",
      role: "combobox",
      "aria-controls": "flight-search-listbox",
      "aria-autocomplete": "list",
      "aria-label": "Search for a flight by number",
    },
    listboxId: "flight-search-listbox",
    optionIdPrefix: "flight-search-option",
    search: searchFlights,
    attach: (list) => panel.insertBefore(list, airportPanel),
    onChoose: choose,
    onEscape,
    beforeRender: renderWatchedRows,
    hasOtherMatches: () => !watchedList.hidden,
  });
  const input = flightBox.input;

  // The airport box.
  const airportBox = new SearchBox({
    inputAttrs: {
      type: "text",
      className: "flight-search-input flight-search-airport-input",
      placeholder: "Search by airport…",
      role: "combobox",
      "aria-controls": "flight-search-route-listbox",
      "aria-autocomplete": "list",
      "aria-label": "Search by origin or destination airport (name, IATA or ICAO code)",
    },
    listboxId: "flight-search-route-listbox",
    optionIdPrefix: "flight-search-route-option",
    search: searchFlightsByAirport,
    attach: (list) => airportPanel.appendChild(list),
    onChoose: choose,
    onEscape,
  });
  const airportInput = airportBox.input;

  const airportPanel = h("div", { className: "flight-search-airport" }, airportInput);

  // A compact watched list, reachable without opening the whole Watch panel:
  // one chip per watched flight, under the search box.
  const chips = h("div", { className: "flight-search-watched" });
  const watchedList = h("ul", { className: "flight-search-results flight-search-results--watched", role: "listbox", id: "flight-search-watched-listbox" });

  const fab = h(
    "button",
    {
      type: "button",
      className: "flight-search-fab control-stack-button",
      "aria-controls": "flight-search-panel",
      onClick: () => toggleControlPanel("search"),
    },
    searchIconSvg(),
  );
  const panelClose = h(
    "button",
    { type: "button", className: "flight-search-panel-close control-panel-close", onClick: () => closeControlPanel("search") },
    "Close search ✕",
  );
  const eyebrow = h("span", { className: "flight-search-eyebrow" }, "Query // Flight No.");
  const panel = h("div", { id: "flight-search-panel", className: "flight-search-panel control-panel" }, panelClose, eyebrow, input, chips, watchedList, airportPanel);
  const container = h("div", { className: "flight-search" }, fab, panel);

  /** Watched flights matching the typed query, by IATA number (SK528) or ICAO callsign (SAS528). */
  function watchedMatches(q: string): { w: WatchedFlight; row: ScheduledFlight | null }[] {
    return watched
      .map((w) => ({ w, row: watchedStatus[watchKey(w)] ?? null }))
      .filter(({ w, row }) => watchedMatchesQuery(w, row, q));
  }

  function renderWatchedChips(): void {
    clear(chips);
    for (const w of watched) {
      chips.appendChild(watchedChip(w, isAirborne(watchedStatus[watchKey(w)] ?? null), () => goToWatched(w)));
    }
    chips.hidden = watched.length === 0;
  }

  function renderWatchedRows(): void {
    clear(watchedList);
    const q = flightBox.query.trim();
    const matches = flightBox.open && q ? watchedMatches(q) : [];
    for (const { w, row } of matches) {
      const airborne = isAirborne(row);
      watchedList.appendChild(
        watchedRow(w, airborne, () => {
          if (airborne) goToWatched(w);
        }),
      );
    }
    watchedList.hidden = matches.length === 0;
  }

  function closeDropdowns(): void {
    flightBox.open = false;
    airportBox.open = false;
  }

  /** The one place the phone panel's open state is written: it must go through
   * the shared stack so another panel never stays open underneath. */
  function setOpen(next: boolean): void {
    mobilePanelOpen = next;
    if (!next) closeDropdowns();
    renderAll();
  }

  function closeMobilePanel(): void {
    closeControlPanel("search");
  }

  /**
   * Keeps the focus trap in step with the panel's own open state: the phone
   * overlay is modal (Tab stays inside, Escape closes, focus returns to the
   * FAB), the desktop dropdown is not. Called from renderAll, so every path
   * that opens or closes the panel (the FAB, the close button, a selection,
   * Escape, a tap outside) goes through here.
   */
  function syncModal(): void {
    const modal = mobilePanelOpen && isPhone();
    if (modal && !trap) {
      // A full-screen overlay is a modal dialog to assistive tech; on desktop
      // the same element is an inline dropdown and carries neither attribute.
      for (const [name, value] of Object.entries(PANEL_MODAL_ATTRS)) panel.setAttribute(name, value);
      trap = activateModal(panel, { onEscape: closeMobilePanel, returnTo: fab });
    } else if (!modal && trap) {
      trap.release();
      trap = null;
      for (const name of Object.keys(PANEL_MODAL_ATTRS)) panel.removeAttribute(name);
    }
  }

  function renderAll(): void {
    panel.classList.toggle("control-panel--open", mobilePanelOpen);
    panel.classList.toggle("flight-search-panel--open", mobilePanelOpen);
    fab.setAttribute("aria-expanded", String(mobilePanelOpen));
    fab.setAttribute("aria-label", mobilePanelOpen ? "Close search" : "Search flights");
    flightBox.syncInput();
    airportBox.syncInput();
    renderWatchedChips();
    flightBox.render();
    airportBox.render();
    syncModal();
  }
  renderAll();

  function handlePointerDown(e: PointerEvent): void {
    if (container.contains(e.target as Node)) return;
    // The map (or another stack button): close the phone panel through the
    // shared stack, and drop the desktop dropdown on the same tap.
    if (mobilePanelOpen) {
      closeControlPanel("search");
      return;
    }
    if (flightBox.open || airportBox.open) {
      closeDropdowns();
      renderAll();
    }
  }
  document.addEventListener("pointerdown", handlePointerDown);

  // A watch added/removed, or a status refresh from the background poll:
  // re-render the chips and the matching rows.
  const unsubscribeWatched = store.subscribeMany(["watchedFlights", "watchedStatus"], () => {
    watched = store.get("watchedFlights");
    watchedStatus = store.get("watchedStatus");
    renderAll();
  });

  root.appendChild(container);
  const unregister = registerControlPanel("search", {
    panel,
    button: fab,
    open: () => setOpen(true),
    close: () => setOpen(false),
  });
  return () => {
    unregister();
    unsubscribeWatched();
    document.removeEventListener("pointerdown", handlePointerDown);
    flightBox.dispose();
    airportBox.dispose();
    trap?.release();
    trap = null;
    container.remove();
  };
}