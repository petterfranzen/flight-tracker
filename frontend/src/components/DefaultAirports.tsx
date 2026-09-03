import { Marker, useMap } from "react-leaflet";
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
export default function DefaultAirports({
  onAirportSelect,
  pane,
  interactive = true,
}: {
  onAirportSelect: (ap: AirportSelection) => void;
  // A dedicated pane guarantees these render above every aircraft/cluster
  // marker regardless of screen position — real feedback (with a
  // screenshot) on the cyberpunk theme, where these render as a *second*,
  // purely visual layer on top of VectorBasemap's own canvas-drawn
  // airport dots (see that component's own comment on why moving its
  // interaction handling here too was more risk than this session had
  // room for). Undefined on the default theme, which has no such pane and
  // no competing airport layer to begin with — falls back to Leaflet's
  // own default markerPane.
  pane?: string;
  // False for the cyberpunk overlay above: VectorBasemap already owns
  // click/hover for airports there (a capture-phase hit-test against
  // WORLD_AIRPORTS, independent of any DOM element) — a second, competing
  // set of click handlers on top would double-fire onAirportSelect for
  // the same click. These markers exist purely to be *seen* on that
  // theme, not clicked.
  interactive?: boolean;
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
  if (pane && !map.getPane(pane)) {
    const el = map.createPane(pane);
    // Above Leaflet's own default markerPane (z-index 600) — see this
    // component's own top comment for why that's the whole point.
    el.style.zIndex = "650";
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
            // Conditionally spread, NOT `pane={pane}`: react-leaflet spreads
            // every Marker prop straight into Leaflet's own options object,
            // and Leaflet's setOptions does `for (var i in options)
            // obj.options[i] = options[i]` against an object whose
            // *prototype* holds the class defaults (pane: 'markerPane').
            // An explicit `pane={undefined}` prop is still an own
            // enumerable key, so that loop sets an own `undefined` that
            // shadows the inherited default — `this.options.pane` then
            // reads back `undefined` instead of falling through to
            // 'markerPane', and Leaflet crashes deep in Marker._initIcon
            // trying to appendChild into `map._panes[undefined]`.
            // Confirmed live (879 render errors, blank app) on the default
            // theme, where `pane` is legitimately undefined. Omitting the
            // key entirely when there's no pane leaves Leaflet's own
            // default intact.
            {...(pane ? { pane } : {})}
            interactive={interactive}
            // Bumps the divIcon element itself above every other marker at
            // the same lat/lng (a busy airport's own traffic) rather than
            // z-indexing the whole markerPane — Leaflet already does this
            // per-marker via setZIndexOffset. On the default theme this is
            // what actually lifts an airport over a nearby aircraft in the
            // shared markerPane; on the cyberpunk overlay it's redundant
            // with the dedicated pane above but harmless.
            zIndexOffset={1000}
            eventHandlers={
              interactive
                ? { click: () => onAirportSelect({ code: ap.code, name: ap.name, lat: ap.pos[1], lon: ap.pos[0] }) }
                : undefined
            }
          />
        );
      })}
    </>
  );
}
