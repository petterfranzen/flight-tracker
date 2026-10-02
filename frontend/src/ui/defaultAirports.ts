import L from "leaflet";
import { AIRPORTS } from "../worldMapData";
import type { AirportSelection } from "../types/flight";
import "../components/DefaultAirports.css";

// Above Leaflet's own markerPane (z-index 600), so an airport is never
// hidden underneath a plane or cluster mark that happens to sit on it.
const AIRPORT_PANE = "airport-overlay";
const AIRPORT_PANE_Z_INDEX = "650";

/**
 * How far down Natural Earth's significance ranking to draw, per zoom
 * level: index is the zoom, value is the highest `rank` still shown (lower
 * rank = more significant). Zooms past the end of the array show
 * everything. See DefaultAirports.tsx's original comment for the
 * per-zoom counts this produces worldwide.
 */
const MAX_RANK_BY_ZOOM = [2, 2, 2, 2, 3, 4, 6, 7, 8];

// Fraction of the viewport kept beyond each edge, so a short pan doesn't
// reveal bare edges before the next moveend refreshes the set.
const VIEW_PAD = 0.5;

/**
 * Every airport on the map, on both themes: a dot plus its IATA code,
 * clickable to open the airport dossier. Loaded lazily (see map.ts) so
 * worldMapData.ts's ~160KB stays out of the main bundle.
 *
 * Markers are reused by AIRPORTS index (stable across re-renders; a
 * handful of IATA codes repeat in the source data, so code itself isn't a
 * safe key) and only added/removed when the visible set actually changes —
 * recomputed on "moveend" (which also fires after every zoom), not "zoom",
 * so a pinch or wheel zoom doesn't remount markers mid-animation.
 *
 * Only airports inside the viewport (plus VIEW_PAD) get a DOM marker. From
 * zoom 5 up the rank rule alone allowed 284 -> 878 markers worldwide, almost
 * all far off screen; Leaflet restyles and transforms every marker on each
 * zoom frame, so that alone made zooming stutter.
 */
export function mount(map: L.Map, onAirportSelect: (ap: AirportSelection) => void): () => void {
  if (!map.getPane(AIRPORT_PANE)) {
    const pane = map.createPane(AIRPORT_PANE);
    pane.style.zIndex = AIRPORT_PANE_Z_INDEX;
  }

  const markers = new Map<number, L.Marker>();

  function render(): void {
    const zoom = map.getZoom();
    const level = Math.max(0, Math.floor(zoom));
    const maxRank = level >= MAX_RANK_BY_ZOOM.length ? Infinity : MAX_RANK_BY_ZOOM[level];
    const seen = new Set<number>();
    const view = map.getBounds().pad(VIEW_PAD);

    AIRPORTS.forEach((ap, index) => {
      if (ap.rank > maxRank) return;
      if (!view.contains([ap.pos[1], ap.pos[0]])) return;
      seen.add(index);
      if (markers.has(index)) return;
      const icon = new L.DivIcon({
        className: "default-airport-icon",
        html: `<span class="default-airport-icon-dot" aria-hidden="true"></span><span class="default-airport-icon-label">${ap.code}</span>`,
        iconSize: [12, 12],
        iconAnchor: [6, 6],
      });
      const marker = L.marker([ap.pos[1], ap.pos[0]], {
        icon,
        pane: AIRPORT_PANE,
        zIndexOffset: 1000,
        // Leaflet's keyboard module makes every marker focusable (tabindex)
        // and, via Map.Keyboard._panOnFocus, auto-pans the map whenever a
        // marker receives DOM focus — including the focus a browser gives
        // any tabbable element on an ordinary mousedown/click, not just real
        // Tab-key navigation. Confirmed live: clicking an airport marker
        // triggered that auto-pan, and it mis-measured this icon as
        // off-screen (tiny 12x12 DivIcon with two absolutely-positioned,
        // overflowing children — not the size/shape panInside's bounds
        // check expects), yanking the view and the marker out from under
        // the click before it could register, so the dossier never opened.
        // Aircraft/cluster markers don't hit this (larger, simpler icons,
        // no overflowing children) so they keep keyboard focus. Airports
        // are still fully clickable by mouse/touch; only Tab-key reachability
        // is traded away here.
        keyboard: false,
      });
      marker.on("click", () => onAirportSelect({ code: ap.code, name: ap.name, lat: ap.pos[1], lon: ap.pos[0] }));
      marker.addTo(map);
      markers.set(index, marker);
    });

    for (const [index, marker] of markers) {
      if (!seen.has(index)) {
        marker.remove();
        markers.delete(index);
      }
    }
  }

  render();
  map.on("moveend", render);

  return () => {
    map.off("moveend", render);
    for (const marker of markers.values()) marker.remove();
    markers.clear();
  };
}
