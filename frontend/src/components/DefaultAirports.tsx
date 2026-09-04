import { Marker, useMap } from "react-leaflet";
import L from "leaflet";
import { AIRPORTS } from "../worldMapData";
import type { AirportSelection } from "../types/flight";
import "./DefaultAirports.css";

// Above Leaflet's own markerPane (z-index 600), so an airport is never
// hidden underneath a plane or cluster mark that happens to sit on it —
// real feedback, with a screenshot. A dedicated pane rather than relying
// on per-marker zIndexOffset alone: Leaflet derives a marker's z-index
// from its latitude, so an aircraft far enough south of an airport can
// still out-stack it within a shared pane no matter what the offset is.
const AIRPORT_PANE = "airport-overlay";
const AIRPORT_PANE_Z_INDEX = "650";

/**
 * Every airport on the map, on both themes: a dot plus its IATA code,
 * clickable to open the airport dossier.
 *
 * Real Leaflet Markers rather than canvas drawing — a DOM marker gets
 * hover and click from the browser for free, instead of needing the
 * mousemove hit-test loop the old cyberpunk canvas renderer maintained for
 * exactly this. That renderer is gone (see MaplibreBasemap), and with it
 * the awkward split where these markers existed on cyberpunk purely to be
 * *seen* while a second, invisible coordinate list handled being clicked.
 */
export default function DefaultAirports({
  onAirportSelect,
}: {
  onAirportSelect: (ap: AirportSelection) => void;
}) {
  const map = useMap();
  // Deliberately not a useEffect: React runs effects child-before-parent
  // (and these 878 Markers are this component's children), so creating
  // the pane in an effect here — or via react-leaflet's own <Pane>
  // component as a sibling, which has exactly the same issue — runs
  // *after* the first Marker has already tried to mount into it. Leaflet
  // threw "Cannot read properties of undefined (reading 'appendChild')"
  // from deep inside Marker._initIcon, confirmed live: the pane genuinely
  // didn't exist yet at that point. Doing this synchronously in the
  // render body — a real side effect, atypical for React, but map panes
  // are plain DOM Leaflet already manages entirely outside React's own
  // tree — guarantees it exists before any child even starts mounting.
  // Idempotent (getPane first) so re-renders don't recreate it.
  if (!map.getPane(AIRPORT_PANE)) {
    map.createPane(AIRPORT_PANE).style.zIndex = AIRPORT_PANE_Z_INDEX;
  }
  return (
    <>
      {AIRPORTS.map((ap, i) => {
        // Built per-airport (not memoized across all 878) so each carries
        // its own IATA code as real text — cheap; L.DivIcon construction
        // itself does no DOM work until Leaflet actually mounts it.
        const icon = new L.DivIcon({
          className: "default-airport-icon",
          html: `<span class="default-airport-icon-dot" aria-hidden="true"></span><span class="default-airport-icon-label">${ap.code}</span>`,
          iconSize: [12, 12],
          iconAnchor: [6, 6],
        });
        return (
          <Marker
            // Index, not ap.code: a handful of codes repeat across
            // distinct AIRPORTS entries (confirmed live — React warned
            // about a duplicate "PZU" key, which was silently dropping
            // most other markers too via broken reconciliation, not just
            // the duplicates themselves). Worth a real dedupe pass in
            // generate_world_map_data.py at some point, but the list
            // itself never reorders, so index is a perfectly stable key
            // in the meantime.
            key={i}
            position={[ap.pos[1], ap.pos[0]]}
            icon={icon}
            pane={AIRPORT_PANE}
            // Belt and braces with the dedicated pane above: this lifts the
            // divIcon over other markers at the same lat/lng, which the
            // pane already handles, but costs nothing and keeps the
            // ordering sane if the pane is ever reconsidered.
            zIndexOffset={1000}
            eventHandlers={{
              click: () => onAirportSelect({ code: ap.code, name: ap.name, lat: ap.pos[1], lon: ap.pos[0] }),
            }}
          />
        );
      })}
    </>
  );
}
