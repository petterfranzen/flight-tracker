import type { AppStore } from "../state/appState";
import type { FlightPosition } from "../types/flight";
import { searchFlights, searchFlightsByAirport } from "../api/flightApi";
import { h, clear } from "./h";
import "../components/FlightSearch.css";

const DEBOUNCE_MS = 250;

function resultLabel(p: FlightPosition): string {
  return p.callsign?.trim() || p.icao24.toUpperCase();
}

function searchIconSvg(): SVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.innerHTML =
    '<path d="M15.5 14h-.79l-.28-.27a6.5 6.5 0 1 0-.7.7l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9z" fill="currentColor" />';
  return svg;
}

/**
 * Two independent search modes sharing one component: the primary
 * flight-number/callsign box (always visible) and an "advanced search"
 * airport panel, expanded on demand. Both funnel into `onSelect`. Kept
 * fully self-contained (no store slots) — nothing outside this module ever
 * needs to know its query/open state, same as the original React version.
 */
export function mount(root: HTMLElement, store: AppStore): () => void {
  function choose(p: FlightPosition): void {
    store.get("selectAircraft")(p);
    query = "";
    results = [];
    open = false;
    activeIndex = -1;
    airportQuery = "";
    routeResults = [];
    routeOpen = false;
    routeActiveIndex = -1;
    mobilePanelOpen = false;
    input.value = "";
    airportInput.value = "";
    renderAll();
  }

  // --- primary callsign search state ---
  let query = "";
  let results: FlightPosition[] = [];
  let open = false;
  let loading = false;
  let activeIndex = -1;
  let requestSeq = 0;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  // --- advanced (airport) search state ---
  let advancedOpen = false;
  let airportQuery = "";
  let routeResults: FlightPosition[] = [];
  let routeOpen = false;
  let routeLoading = false;
  let routeActiveIndex = -1;
  let routeRequestSeq = 0;
  let routeDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  let mobilePanelOpen = false;

  function runQuery(): void {
    if (debounceTimer) clearTimeout(debounceTimer);
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      requestSeq++;
      results = [];
      loading = false;
      renderResults();
      return;
    }
    const seq = ++requestSeq;
    loading = true;
    renderResults();
    debounceTimer = setTimeout(() => {
      searchFlights(trimmed)
        .then((list) => {
          if (seq !== requestSeq) return;
          results = list;
          activeIndex = list.length > 0 ? 0 : -1;
        })
        .catch(() => {
          if (seq !== requestSeq) return;
          results = [];
          activeIndex = -1;
        })
        .finally(() => {
          if (seq === requestSeq) loading = false;
          renderResults();
        });
    }, DEBOUNCE_MS);
  }

  function runRouteQuery(): void {
    if (routeDebounceTimer) clearTimeout(routeDebounceTimer);
    const trimmed = airportQuery.trim();
    if (trimmed.length === 0) {
      routeRequestSeq++;
      routeResults = [];
      routeLoading = false;
      renderRouteResults();
      return;
    }
    const seq = ++routeRequestSeq;
    routeLoading = true;
    renderRouteResults();
    routeDebounceTimer = setTimeout(() => {
      searchFlightsByAirport(trimmed)
        .then((list) => {
          if (seq !== routeRequestSeq) return;
          routeResults = list;
          routeActiveIndex = list.length > 0 ? 0 : -1;
        })
        .catch(() => {
          if (seq !== routeRequestSeq) return;
          routeResults = [];
          routeActiveIndex = -1;
        })
        .finally(() => {
          if (seq === routeRequestSeq) routeLoading = false;
          renderRouteResults();
        });
    }, DEBOUNCE_MS);
  }

  // --- DOM ---
  const resultsList = h("ul", { className: "flight-search-results", role: "listbox", id: "flight-search-listbox" });
  const input = h("input", {
    type: "text",
    inputMode: "search",
    className: "flight-search-input",
    placeholder: "Search by flight number…",
    role: "combobox",
    "aria-controls": "flight-search-listbox",
    "aria-autocomplete": "list",
    "aria-label": "Search for a flight by number",
  }) as HTMLInputElement;
  input.addEventListener("input", () => {
    query = input.value;
    open = true;
    runQuery();
    renderResults();
  });
  input.addEventListener("focus", () => {
    open = true;
    renderResults();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      open = false;
      mobilePanelOpen = false;
      renderAll();
      return;
    }
    if (!open || results.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      activeIndex = (activeIndex + 1) % results.length;
      renderResults();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      activeIndex = (activeIndex - 1 + results.length) % results.length;
      renderResults();
    } else if (e.key === "Enter") {
      e.preventDefault();
      const pick = results[activeIndex] ?? results[0];
      if (pick) choose(pick);
    }
  });

  const routeResultsList = h("ul", { className: "flight-search-results", role: "listbox", id: "flight-search-route-listbox" });
  const airportInput = h("input", {
    type: "text",
    className: "flight-search-input flight-search-advanced-input",
    placeholder: "Search by airport (name, IATA, or ICAO)…",
    role: "combobox",
    "aria-controls": "flight-search-route-listbox",
    "aria-autocomplete": "list",
    "aria-label": "Search by origin or destination airport",
  }) as HTMLInputElement;
  airportInput.addEventListener("input", () => {
    airportQuery = airportInput.value;
    routeOpen = true;
    runRouteQuery();
    renderRouteResults();
  });
  airportInput.addEventListener("focus", () => {
    routeOpen = true;
    renderRouteResults();
  });
  airportInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      routeOpen = false;
      mobilePanelOpen = false;
      renderAll();
      return;
    }
    if (!routeOpen || routeResults.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      routeActiveIndex = (routeActiveIndex + 1) % routeResults.length;
      renderRouteResults();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      routeActiveIndex = (routeActiveIndex - 1 + routeResults.length) % routeResults.length;
      renderRouteResults();
    } else if (e.key === "Enter") {
      e.preventDefault();
      const pick = routeResults[routeActiveIndex] ?? routeResults[0];
      if (pick) choose(pick);
    }
  });

  const advancedPanel = h("div", { id: "flight-search-advanced-panel", className: "flight-search-advanced-panel" }, airportInput);
  const advancedToggle = h(
    "button",
    {
      type: "button",
      className: "flight-search-advanced-toggle",
      "aria-controls": "flight-search-advanced-panel",
      onClick: () => {
        advancedOpen = !advancedOpen;
        renderAll();
      },
    },
    "Advanced search (airport) ▼",
  );

  const fab = h(
    "button",
    {
      type: "button",
      className: "flight-search-fab",
      "aria-controls": "flight-search-panel",
      onClick: () => {
        mobilePanelOpen = !mobilePanelOpen;
        renderAll();
      },
    },
    searchIconSvg(),
  );
  const panelClose = h(
    "button",
    { type: "button", className: "flight-search-panel-close", onClick: () => { mobilePanelOpen = false; renderAll(); } },
    "Close search ✕",
  );
  const eyebrow = h("span", { className: "flight-search-eyebrow" }, "Query // Flight No.");
  const panel = h("div", { id: "flight-search-panel", className: "flight-search-panel" }, panelClose, eyebrow, input, advancedToggle);
  const container = h("div", { className: "flight-search" }, fab, panel);

  function setActiveRow(listEl: HTMLElement, activeIdx: number): void {
    Array.from(listEl.children).forEach((child, i) => {
      const isActive = i === activeIdx;
      child.classList.toggle("flight-search-option--active", isActive);
      child.setAttribute("aria-selected", String(isActive));
    });
  }

  function resultRow(p: FlightPosition, i: number, active: boolean, idPrefix: string, onChoose: (p: FlightPosition) => void): HTMLElement {
    const li = h(
      "li",
      {
        id: `${idPrefix}-${i}`,
        role: "option",
        "aria-selected": String(active),
        className: `flight-search-option${active ? " flight-search-option--active" : ""}`,
        // Updates only the active/aria-selected state on the existing rows
        // (no rebuild): a hover is exactly the moment Playwright's own
        // click() sequence is mid-flight (it hovers before it clicks), and
        // replacing the list's DOM nodes out from under a real, in-flight
        // pointer sequence loses the click entirely — confirmed live (a
        // synthetic in-page click always reached `choose`; a real
        // Playwright `.click()` on this same element never did, until this
        // handler stopped rebuilding the list on every hover).
        onMouseenter: () => {
          if (idPrefix === "flight-search-option") {
            activeIndex = i;
            setActiveRow(resultsList, i);
            input.setAttribute("aria-activedescendant", `flight-search-option-${i}`);
          } else {
            routeActiveIndex = i;
            setActiveRow(routeResultsList, i);
            airportInput.setAttribute("aria-activedescendant", `flight-search-route-option-${i}`);
          }
        },
        onMousedown: (e: MouseEvent) => e.preventDefault(),
        onClick: () => onChoose(p),
      },
      h("span", { className: "flight-search-callsign" }, resultLabel(p)),
      h("span", { className: "flight-search-icao" }, p.icao24.toUpperCase()),
    );
    return li;
  }

  function renderResults(): void {
    const showDropdown = open && query.trim().length > 0;
    clear(resultsList);
    if (showDropdown) {
      if (!resultsList.parentElement) panel.insertBefore(resultsList, advancedToggle);
      if (loading && results.length === 0) resultsList.append(h("li", { className: "flight-search-status" }, "Searching…"));
      else if (!loading && results.length === 0) resultsList.append(h("li", { className: "flight-search-status" }, "No matching flights"));
      results.forEach((p, i) => resultsList.append(resultRow(p, i, i === activeIndex, "flight-search-option", choose)));
    } else if (resultsList.parentElement) {
      resultsList.remove();
    }
    input.setAttribute("aria-expanded", String(showDropdown));
    if (activeIndex >= 0 && showDropdown) input.setAttribute("aria-activedescendant", `flight-search-option-${activeIndex}`);
    else input.removeAttribute("aria-activedescendant");
  }

  function renderRouteResults(): void {
    const showDropdown = routeOpen && airportQuery.trim().length > 0;
    clear(routeResultsList);
    if (showDropdown) {
      if (!routeResultsList.parentElement) advancedPanel.appendChild(routeResultsList);
      if (routeLoading && routeResults.length === 0) routeResultsList.append(h("li", { className: "flight-search-status" }, "Searching…"));
      else if (!routeLoading && routeResults.length === 0) routeResultsList.append(h("li", { className: "flight-search-status" }, "No matching flights"));
      routeResults.forEach((p, i) => routeResultsList.append(resultRow(p, i, i === routeActiveIndex, "flight-search-route-option", choose)));
    } else if (routeResultsList.parentElement) {
      routeResultsList.remove();
    }
    airportInput.setAttribute("aria-expanded", String(showDropdown));
    if (routeActiveIndex >= 0 && showDropdown) airportInput.setAttribute("aria-activedescendant", `flight-search-route-option-${routeActiveIndex}`);
    else airportInput.removeAttribute("aria-activedescendant");
  }

  function renderAll(): void {
    panel.classList.toggle("flight-search-panel--open", mobilePanelOpen);
    fab.setAttribute("aria-expanded", String(mobilePanelOpen));
    fab.setAttribute("aria-label", mobilePanelOpen ? "Close search" : "Search flights");
    advancedToggle.setAttribute("aria-expanded", String(advancedOpen));
    advancedToggle.textContent = advancedOpen ? "Hide advanced search ▲" : "Advanced search (airport) ▼";
    if (advancedOpen) {
      if (!advancedPanel.parentElement) panel.appendChild(advancedPanel);
    } else if (advancedPanel.parentElement) {
      advancedPanel.remove();
    }
    if (input.value !== query) input.value = query;
    if (airportInput.value !== airportQuery) airportInput.value = airportQuery;
    renderResults();
    renderRouteResults();
  }
  renderAll();

  function handlePointerDown(e: PointerEvent): void {
    if (!container.contains(e.target as Node)) {
      open = false;
      routeOpen = false;
      mobilePanelOpen = false;
      renderAll();
    }
  }
  document.addEventListener("pointerdown", handlePointerDown);

  root.appendChild(container);
  return () => {
    document.removeEventListener("pointerdown", handlePointerDown);
    if (debounceTimer) clearTimeout(debounceTimer);
    if (routeDebounceTimer) clearTimeout(routeDebounceTimer);
    container.remove();
  };
}
