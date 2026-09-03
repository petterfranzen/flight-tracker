import { Marker } from "react-leaflet";
import L from "leaflet";
import { AIRPORTS } from "../worldMapData";
import type { AirportSelection } from "./VectorBasemap";
import "./DefaultAirports.css";

/**
 * The default theme's own airport layer — until now, airport dots/click-
 * to-select only existed on VectorBasemap's cyberpunk-only canvas, so the
 * plain-OpenStreetMap theme had no airports at all. Real Leaflet Markers
 * here rather than VectorBasemap's canvas-plus-manual-hit-testing
 * approach: there's no shared canvas/buffer-cache system to hook into on
 * this theme (just a plain TileLayer), and a real DOM marker gets hover/
 * click for free from the browser instead of needing its own mousemove
 * hit-test loop. Reuses the same AIRPORTS data and onAirportSelect
 * callback as VectorBasemap, so the airport dossier panel is identical
 * either way.
 */
export default function DefaultAirports({ onAirportSelect }: { onAirportSelect: (ap: AirportSelection) => void }) {
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
            // Bumps the divIcon element itself above every other marker at
            // the same lat/lng (a busy airport's own traffic) rather than
            // z-indexing the whole markerPane — Leaflet already does this
            // per-marker via setZIndexOffset, no custom pane needed here.
            zIndexOffset={1000}
            eventHandlers={{ click: () => onAirportSelect({ code: ap.code, name: ap.name, lat: ap.pos[1], lon: ap.pos[0] }) }}
          />
        );
      })}
    </>
  );
}
