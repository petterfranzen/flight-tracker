import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import type { FlightPosition } from "../types/flight";
import { searchFlights, searchFlightsByAirport } from "../api/flightApi";
import "./FlightSearch.css";

// Waits this long after the last keystroke before actually searching — a
// search-per-keystroke would fire a request on every character of a
// flight number, most of which get superseded before their response even
// lands.
const DEBOUNCE_MS = 250;

function resultLabel(p: FlightPosition): string {
  return p.callsign?.trim() || p.icao24.toUpperCase();
}

/**
 * Two independent search modes sharing one component: the primary
 * flight-number/callsign box (always visible), and an "advanced search"
 * panel with a single airport field, expanded on demand — matches an
 * aircraft whose origin OR destination airport matches (see
 * searchFlightsByAirport), not a from/to route pair. Both funnel into the
 * same `onSelect`, and share the same debounced/guarded-against-out-of-
 * order-response fetch pattern; see FlightMap's liveRequestSeqRef for the
 * same idea applied to position fetches. Selecting a result just hands the
 * matched FlightPosition to `onSelect` (FlightMap's handleSelect) — which
 * already does everything "zoom to where the plane is" needs.
 */
export default function FlightSearch({ onSelect }: { onSelect: (p: FlightPosition) => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<FlightPosition[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const requestSeqRef = useRef(0);

  // Mobile only (see FlightSearch.css's max-width media query) — desktop
  // ignores this entirely, the panel is always visible there regardless of
  // this flag. Starts closed so a phone loads straight to the map, not a
  // search box covering it.
  const [mobilePanelOpen, setMobilePanelOpen] = useState(false);

  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [airportQuery, setAirportQuery] = useState("");
  const [routeResults, setRouteResults] = useState<FlightPosition[]>([]);
  const [routeOpen, setRouteOpen] = useState(false);
  const [routeLoading, setRouteLoading] = useState(false);
  const [routeActiveIndex, setRouteActiveIndex] = useState(-1);
  const routeRequestSeqRef = useRef(0);

  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      requestSeqRef.current++; // invalidate any in-flight search
      setResults([]);
      setLoading(false);
      return;
    }
    const seq = ++requestSeqRef.current;
    setLoading(true);
    const timer = setTimeout(() => {
      searchFlights(trimmed)
        .then((list) => {
          if (seq !== requestSeqRef.current) return;
          setResults(list);
          setActiveIndex(list.length > 0 ? 0 : -1);
        })
        .catch(() => {
          if (seq !== requestSeqRef.current) return;
          setResults([]);
          setActiveIndex(-1);
        })
        .finally(() => {
          if (seq === requestSeqRef.current) setLoading(false);
        });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  // Advanced (airport) search — same debounce/out-of-order-response guard
  // as the callsign search above, keyed off the field changing.
  useEffect(() => {
    const trimmedAirport = airportQuery.trim();
    if (trimmedAirport.length === 0) {
      routeRequestSeqRef.current++;
      setRouteResults([]);
      setRouteLoading(false);
      return;
    }
    const seq = ++routeRequestSeqRef.current;
    setRouteLoading(true);
    const timer = setTimeout(() => {
      searchFlightsByAirport(trimmedAirport)
        .then((list) => {
          if (seq !== routeRequestSeqRef.current) return;
          setRouteResults(list);
          setRouteActiveIndex(list.length > 0 ? 0 : -1);
        })
        .catch(() => {
          if (seq !== routeRequestSeqRef.current) return;
          setRouteResults([]);
          setRouteActiveIndex(-1);
        })
        .finally(() => {
          if (seq === routeRequestSeqRef.current) setRouteLoading(false);
        });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [airportQuery]);

  useEffect(() => {
    function handlePointerDown(e: PointerEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setRouteOpen(false);
        setMobilePanelOpen(false);
      }
    }
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, []);

  function choose(p: FlightPosition) {
    onSelect(p);
    setQuery("");
    setResults([]);
    setOpen(false);
    setActiveIndex(-1);
    setAirportQuery("");
    setRouteResults([]);
    setRouteOpen(false);
    setRouteActiveIndex(-1);
    setMobilePanelOpen(false);
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      setOpen(false);
      setMobilePanelOpen(false);
      return;
    }
    if (!open || results.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % results.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => (i - 1 + results.length) % results.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const pick = results[activeIndex] ?? results[0];
      if (pick) choose(pick);
    }
  }

  function handleRouteKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      setRouteOpen(false);
      setMobilePanelOpen(false);
      return;
    }
    if (!routeOpen || routeResults.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setRouteActiveIndex((i) => (i + 1) % routeResults.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setRouteActiveIndex((i) => (i - 1 + routeResults.length) % routeResults.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const pick = routeResults[routeActiveIndex] ?? routeResults[0];
      if (pick) choose(pick);
    }
  }

  const showDropdown = open && query.trim().length > 0;
  const showRouteDropdown = routeOpen && airportQuery.trim().length > 0;
  const routeActiveDescendant =
    routeActiveIndex >= 0 && showRouteDropdown ? `flight-search-route-option-${routeActiveIndex}` : undefined;

  return (
    <div className="flight-search" ref={containerRef}>
      {/* Mobile only (see FlightSearch.css) — desktop never renders this
          as visible, the panel below is simply always shown there. An
          inline SVG magnifying glass, not an emoji: this codebase already
          rejected emoji glyphs elsewhere (see PLANE_SVG above) since their
          rendering isn't portable across fonts/platforms. */}
      <button
        type="button"
        className="flight-search-fab"
        onClick={() => setMobilePanelOpen((v) => !v)}
        aria-expanded={mobilePanelOpen}
        aria-controls="flight-search-panel"
        aria-label={mobilePanelOpen ? "Close search" : "Search flights"}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path
            d="M15.5 14h-.79l-.28-.27a6.5 6.5 0 1 0-.7.7l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9z"
            fill="currentColor"
          />
        </svg>
      </button>
      <div
        id="flight-search-panel"
        className={`flight-search-panel${mobilePanelOpen ? " flight-search-panel--open" : ""}`}
      >
      {/* Mobile only — the FAB above already toggles the panel closed too,
          but a labeled close action inside the sheet itself is a more
          discoverable affordance than relying on someone finding their way
          back to a button that's now hidden behind this same overlay. */}
      <button
        type="button"
        className="flight-search-panel-close"
        onClick={() => setMobilePanelOpen(false)}
      >
        Close search ✕
      </button>
      {/* Cyberpunk-only (see FlightSearch.css) — default theme's plain
          placeholder text already says what the field is for. */}
      <span className="flight-search-eyebrow">Query // Flight No.</span>
      <input
        type="text"
        inputMode="search"
        className="flight-search-input"
        placeholder="Search by flight number…"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={handleKeyDown}
        role="combobox"
        aria-expanded={showDropdown}
        aria-controls="flight-search-listbox"
        aria-autocomplete="list"
        aria-label="Search for a flight by number"
        aria-activedescendant={activeIndex >= 0 && showDropdown ? `flight-search-option-${activeIndex}` : undefined}
      />
      {showDropdown && (
        <ul className="flight-search-results" role="listbox" id="flight-search-listbox">
          {loading && results.length === 0 && <li className="flight-search-status">Searching…</li>}
          {!loading && results.length === 0 && <li className="flight-search-status">No matching flights</li>}
          {results.map((p, i) => (
            <li
              key={p.icao24}
              id={`flight-search-option-${i}`}
              role="option"
              aria-selected={i === activeIndex}
              className={`flight-search-option${i === activeIndex ? " flight-search-option--active" : ""}`}
              onMouseEnter={() => setActiveIndex(i)}
              // Fires before the input's onBlur/dropdown-close logic would
              // otherwise dismiss the list out from under the click.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => choose(p)}
            >
              <span className="flight-search-callsign">{resultLabel(p)}</span>
              <span className="flight-search-icao">{p.icao24.toUpperCase()}</span>
            </li>
          ))}
        </ul>
      )}

      <button
        type="button"
        className="flight-search-advanced-toggle"
        onClick={() => setAdvancedOpen((v) => !v)}
        aria-expanded={advancedOpen}
        aria-controls="flight-search-advanced-panel"
      >
        {advancedOpen ? "Hide advanced search ▲" : "Advanced search (airport) ▼"}
      </button>

      {advancedOpen && (
        <div id="flight-search-advanced-panel" className="flight-search-advanced-panel">
          <input
            type="text"
            className="flight-search-input flight-search-advanced-input"
            placeholder="Search by airport (name, IATA, or ICAO)…"
            value={airportQuery}
            onChange={(e) => {
              setAirportQuery(e.target.value);
              setRouteOpen(true);
            }}
            onFocus={() => setRouteOpen(true)}
            onKeyDown={handleRouteKeyDown}
            role="combobox"
            aria-expanded={showRouteDropdown}
            aria-controls="flight-search-route-listbox"
            aria-autocomplete="list"
            aria-label="Search by origin or destination airport"
            aria-activedescendant={routeActiveDescendant}
          />
          {showRouteDropdown && (
            <ul className="flight-search-results" role="listbox" id="flight-search-route-listbox">
              {routeLoading && routeResults.length === 0 && <li className="flight-search-status">Searching…</li>}
              {!routeLoading && routeResults.length === 0 && (
                <li className="flight-search-status">No matching flights</li>
              )}
              {routeResults.map((p, i) => (
                <li
                  key={p.icao24}
                  id={`flight-search-route-option-${i}`}
                  role="option"
                  aria-selected={i === routeActiveIndex}
                  className={`flight-search-option${i === routeActiveIndex ? " flight-search-option--active" : ""}`}
                  onMouseEnter={() => setRouteActiveIndex(i)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => choose(p)}
                >
                  <span className="flight-search-callsign">{resultLabel(p)}</span>
                  <span className="flight-search-icao">{p.icao24.toUpperCase()}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      </div>
    </div>
  );
}
