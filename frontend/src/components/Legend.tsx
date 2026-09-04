import { useState } from "react";
import "./Legend.css";

/**
 * Static swatch key for the marks on the map that aren't self-evident —
 * which aircraft is selected, and what an airport dot looks like.
 *
 * Collapsible, same interaction pattern as FlightSearch's advanced panel
 * and FavoritesPanel — this used to render permanently open, which on a
 * real phone (stacked in the same left-overlay-stack column as those two,
 * see FlightMap.css) meant it and its fixed ~150px cost were *always*
 * eating screen real estate a user hadn't asked for, on top of whatever
 * Favorites/Search had already opened. Purely informational content
 * (explaining symbols, nothing to act on — see FavoritesPanel/FlightSearch
 * for the actual interactive panels), so defaulting closed costs nothing
 * a first-time user can't get back with one tap.
 */
// Same info-circle glyph as Dock's own (currently inert) "Details" tile
// — reads as "more info" more directly than a bare chevron, matching
// what this button actually does (reveal an explanatory key).
function InfoIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="map-legend-toggle-icon">
      <circle cx="12" cy="12" r="9" />
      <line x1="12" y1="11" x2="12" y2="16.5" />
      <circle cx="12" cy="7.5" r="0.6" fill="currentColor" />
    </svg>
  );
}

// No longer theme-dependent. The airport mark used to be cyberpunk-only,
// back when airports were drawn into that theme's own canvas; they're real
// Leaflet markers on both themes now (see DefaultAirports), so the row
// applies either way. The "home region" row went with the amber
// home-country outline, which the canvas renderer drew and the vector
// basemap deliberately doesn't reproduce.
export default function Legend() {
  const [open, setOpen] = useState(false);
  return (
    <div className="map-legend">
      {/* Mobile only (see Legend.css) — same collapse-to-FAB pattern as
          FlightSearch/FavoritesPanel: desktop never shows this (the
          toggle button below is simply always visible there), a phone
          gets an icon-only button that expands into a full-screen
          overlay instead of a permanently-visible text button + card. */}
      <button
        type="button"
        className="map-legend-fab"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="map-legend-body"
        aria-label={open ? "Close legend" : "Legend"}
      >
        <InfoIcon />
      </button>
      <div id="map-legend-body" className={`map-legend-body${open ? " map-legend-body--open" : ""}`}>
        {/* Mobile only — the FAB above already toggles this closed too,
            but a labeled close action inside the sheet itself is a more
            discoverable affordance than relying on someone finding their
            way back to a button now hidden behind this same overlay. */}
        <button type="button" className="map-legend-body-close" onClick={() => setOpen(false)}>
          Close legend ✕
        </button>
        <button
          type="button"
          className="map-legend-toggle"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls="map-legend-content"
        >
          <InfoIcon /> {open ? "Hide legend ▲" : "Legend ▼"}
        </button>
        {open && (
          <ul className="map-legend-list" id="map-legend-content">
            <li className="map-legend-row">
              <span className="map-legend-swatch map-legend-swatch--aircraft" />
              Live aircraft
            </li>
            <li className="map-legend-row">
              <span className="map-legend-swatch map-legend-swatch--selected" />
              Tracked / selected
            </li>
            <li className="map-legend-row">
              <span className="map-legend-swatch map-legend-swatch--airport" />
              Airport
            </li>
          </ul>
        )}
      </div>
    </div>
  );
}
