import { useState } from "react";
import "./Legend.css";

/**
 * Static swatch key for the cyberpunk theme's vector basemap — explains
 * marks that aren't otherwise self-evident (airport squares, the
 * home-country amber outline) the way the default theme's plain
 * OpenStreetMap imagery never needed one for. Matches the earlier
 * approved mockup's own legend card: same four rows, same colors.
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
export default function Legend() {
  const [open, setOpen] = useState(false);
  return (
    <div className="map-legend">
      <button
        type="button"
        className="map-legend-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="map-legend-content"
      >
        {open ? "Hide legend ▲" : "Legend ▼"}
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
          <li className="map-legend-row">
            <span className="map-legend-swatch map-legend-swatch--home" />
            Home region
          </li>
        </ul>
      )}
    </div>
  );
}
