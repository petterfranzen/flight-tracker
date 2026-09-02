import "./Legend.css";

/**
 * Static swatch key for the cyberpunk theme's vector basemap — explains
 * marks that aren't otherwise self-evident (airport squares, the
 * home-country amber outline) the way the default theme's plain
 * OpenStreetMap imagery never needed one for. Matches the earlier
 * approved mockup's own legend card: same four rows, same colors.
 */
export default function Legend() {
  return (
    <div className="map-legend">
      <span className="map-legend-eyebrow">Legend</span>
      <ul className="map-legend-list">
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
    </div>
  );
}
