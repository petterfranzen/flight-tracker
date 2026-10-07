import { Marker } from "maplibre-gl";
import type { FlightMap } from "../map/map";
import { AIRPORTS } from "../worldMapData";
import type { AirportSelection } from "../types/flight";
import "../components/DefaultAirports.css";

// Above every plane marker (markers.ts stacks planes at 0-2), so an airport
// is never hidden underneath a plane that happens to sit on it.
const AIRPORT_Z_INDEX = "3";
const ICON_PX = 12;

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
 * Every airport on the map: a dot plus its IATA code, clickable to open
 * the airport dossier. Loaded lazily (see main.ts) so
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
 * all far off screen, and every marker is re-placed on each frame of a pan
 * or zoom.
 */
export function mount(map: FlightMap, onAirportSelect: (ap: AirportSelection) => void): () => void {
  const markers = new Map<number, Marker>();

  function render(): void {
    const level = Math.max(0, Math.floor(map.getZoom()));
    const maxRank = level >= MAX_RANK_BY_ZOOM.length ? Infinity : MAX_RANK_BY_ZOOM[level];
    const seen = new Set<number>();
    const b = map.getBounds();
    const padLat = (b.latMax - b.latMin) * VIEW_PAD;
    const padLon = (b.lonMax - b.lonMin) * VIEW_PAD;

    AIRPORTS.forEach((ap, index) => {
      if (ap.rank > maxRank) return;
      const [lon, lat] = ap.pos;
      if (lat < b.latMin - padLat || lat > b.latMax + padLat || lon < b.lonMin - padLon || lon > b.lonMax + padLon) return;
      seen.add(index);
      if (markers.has(index)) return;
      const el = document.createElement("div");
      el.className = "default-airport-icon";
      el.style.width = `${ICON_PX}px`;
      el.style.height = `${ICON_PX}px`;
      el.style.zIndex = AIRPORT_Z_INDEX;
      el.innerHTML = `<span class="default-airport-icon-dot" aria-hidden="true"></span><span class="default-airport-icon-label">${ap.code}</span>`;
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        onAirportSelect({ code: ap.code, name: ap.name, lat, lon });
      });
      const marker = new Marker({ element: el, anchor: "center" }).setLngLat([lon, lat]).addTo(map.gl);
      // Test-only hook, as on plane markers (see tests/airport-density.spec.ts).
      (el as unknown as { _marker: Marker })._marker = marker;
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
