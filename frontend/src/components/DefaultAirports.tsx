import { useEffect, useMemo, useState } from "react";
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
 * How far down Natural Earth's significance ranking to draw, per zoom
 * level: index is the zoom, value is the highest `rank` still shown
 * (lower rank = more significant). Zooms past the end of the array show
 * everything.
 *
 * Drawing all 878 at every zoom made the world view unreadable — a solid
 * band of overlapping IATA labels across Europe and the US eastern
 * seaboard, with the aircraft underneath them. Natural Earth's scalerank
 * already encodes "how zoomed out can this still earn a place", so this
 * just follows it.
 *
 * Resulting counts worldwide — and at these zooms the whole world *is* the
 * viewport, so these are what you actually see:
 *   z<=3: 65   z4: 90   z5: 284   z6: 480   z7: 612   z8: 850   z9+: 878
 *
 * The steps aren't evenly spaced because Natural Earth's tiers aren't:
 * rank 5 holds only 46 airports, so pausing on it left a regional view
 * visibly emptier than the zoom either side of it.
 *
 * Thresholds live here rather than in the generator so they can be tuned
 * without regenerating worldMapData.ts.
 */
const MAX_RANK_BY_ZOOM = [2, 2, 2, 2, 3, 4, 6, 7, 8];

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

  // Which airports are drawn depends on zoom, so this has to re-render
  // when zoom changes. "zoomend" only, not "zoom": re-filtering on every
  // frame of a pinch or wheel zoom would remount markers mid-animation
  // for no visible benefit — the same reasoning ScaleBar.tsx uses.
  const [zoom, setZoom] = useState(() => map.getZoom());
  useEffect(() => {
    const update = () => setZoom(map.getZoom());
    map.on("zoomend", update);
    return () => {
      map.off("zoomend", update);
    };
  }, [map]);

  const visible = useMemo(() => {
    const level = Math.max(0, Math.floor(zoom));
    const maxRank =
      level >= MAX_RANK_BY_ZOOM.length ? Infinity : MAX_RANK_BY_ZOOM[level];
    // The original index is carried through as the React key. Filtering
    // first and using the filtered index would mean a marker's key
    // changed with zoom, so React would reuse one airport's DOM node for
    // a different airport as the list grew — the same class of breakage
    // the duplicate-code keys caused before (see the key comment below).
    return AIRPORTS.map((ap, index) => ({ ap, index })).filter(
      ({ ap }) => ap.rank <= maxRank,
    );
  }, [zoom]);

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
      {visible.map(({ ap, index }) => {
        // Built per-airport (not memoized across the whole list) so each carries
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
            key={index}
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
