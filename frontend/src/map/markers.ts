import L from "leaflet";
import type { LiveMarker, SelectedPosition } from "../types/flight";

// A small rotated dart stands in for the transponder icon — heading comes
// straight off the state vector. Authored pointing straight up (north), so
// rotate(headingDeg) with no correction term is always correct by
// construction (see the original FlightMap.tsx PLANE_SVG comment for the
// emoji-glyph approach this replaced and why).
export const PLANE_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true">
  <path d="M12 2 L19 20 L12 16 L5 20 Z" />
</svg>`;

// Big on purpose: with overlapping planes hidden (see map/declutter.ts) rather
// than clustered, every plane drawn has to be easy to see and to hit.
const ICON_SIZE = 72;
const SELECTED_ICON_SIZE = 90;
const MOBILE_BREAKPOINT_PX = 768;
const MOBILE_ICON_SIZE = 92;
const MOBILE_SELECTED_ICON_SIZE = 115;

// Aircraft icons shrink toward this floor as you zoom out; full size from
// FULL_SIZE_ZOOM (== SELECTED_MIN_ZOOM in map.ts) upward.
const MIN_ICON_SIZE_PX = 18;
const FULL_SIZE_ZOOM = 10;

// Zoomed in there is room (and a bigger target to hit): icons keep growing
// past full size, up to GROWN_ICON_FACTOR times it at GROWN_ICON_ZOOM.
const GROWN_ICON_ZOOM = 14;
const GROWN_ICON_FACTOR = 1.4;

function scaleIconSize(base: number, zoom: number): number {
  if (zoom >= FULL_SIZE_ZOOM) {
    const t = Math.min(1, (zoom - FULL_SIZE_ZOOM) / (GROWN_ICON_ZOOM - FULL_SIZE_ZOOM));
    return Math.round(base * (1 + (GROWN_ICON_FACTOR - 1) * t));
  }
  const t = Math.max(0, zoom) / FULL_SIZE_ZOOM;
  return Math.round(MIN_ICON_SIZE_PX + (base - MIN_ICON_SIZE_PX) * t);
}

/** The side of an unselected plane's icon box at this zoom, px (what overlap is measured against). */
export function planeBoxSize(zoom: number): number {
  const mobile = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT_PX}px)`).matches;
  return scaleIconSize(mobile ? MOBILE_ICON_SIZE : ICON_SIZE, Math.round(zoom));
}

/**
 * A DivIcon that stamps the current rotation onto its glyph the moment
 * Leaflet actually creates the DOM node, reading it from a live ref rather
 * than a value baked in at construction time — see markers.ts's own
 * updateEntry, which mutates headingRef.current on every position tick
 * without ever rebuilding the icon. callsignRef is written once (a
 * callsign never changes after a marker first exists) and read the same
 * safe way (textContent, not interpolated into the html string) since
 * callsign is untrusted external OpenSky data.
 */
class RotatingPlaneIcon extends L.DivIcon {
  headingRef: { current: number };
  callsignRef: { current: string };
  constructor(options: L.DivIconOptions, headingRef: { current: number }, callsignRef: { current: string }) {
    super(options);
    this.headingRef = headingRef;
    this.callsignRef = callsignRef;
  }
  createIcon(oldIcon?: HTMLElement) {
    const el = super.createIcon(oldIcon);
    const glyph = el.querySelector<HTMLElement>(".plane-glyph");
    if (glyph) glyph.style.transform = `rotate(${this.headingRef.current}deg)`;
    const label = el.querySelector<HTMLElement>(".plane-icon-label");
    if (label) label.textContent = this.callsignRef.current;
    return el;
  }
}

interface IconParams {
  known: boolean;
  selected: boolean;
  zoom: number;
  entering: boolean;
  exiting: boolean;
  dimmed: boolean;
}

function iconParamsKey(p: IconParams): string {
  return `${p.known}|${p.selected}|${p.zoom}|${p.entering}|${p.exiting}|${p.dimmed}`;
}

// Icon *options* (className/html/size) are cacheable across markers sharing
// the same (known, selected, zoom, entering, exiting) tuple — only
// headingRef/callsignRef need to stay per-marker (see RotatingPlaneIcon's
// own comment), so each marker still gets its own icon instance built from
// these shared, immutable options.
const iconOptionsCache = new Map<string, L.DivIconOptions>();

function planeIconOptions(known: boolean, selected: boolean, zoom: number, entering: boolean, exiting: boolean, dimmed: boolean): L.DivIconOptions {
  const key = iconParamsKey({ known, selected, zoom, entering, exiting, dimmed });
  const cached = iconOptionsCache.get(key);
  if (cached) return cached;

  const glyphClass = known ? "plane-glyph" : "plane-glyph plane-glyph--unknown-heading";
  const isMobile = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT_PX}px)`).matches;
  const baseSize = selected ? (isMobile ? MOBILE_SELECTED_ICON_SIZE : SELECTED_ICON_SIZE) : isMobile ? MOBILE_ICON_SIZE : ICON_SIZE;
  const size = selected ? Math.max(scaleIconSize(baseSize, zoom), 16) : scaleIconSize(baseSize, zoom);

  const options: L.DivIconOptions = {
    className: `plane-icon${selected ? " plane-icon--selected" : ""}${entering ? " plane-icon--entering" : ""}${exiting ? " plane-icon--exiting" : ""}${dimmed ? " plane-icon--dimmed" : ""}`,
    html: `<div class="plane-icon-halo" aria-hidden="true"></div><div class="plane-icon-mark" aria-hidden="true"></div><div class="${glyphClass}" role="img" aria-label="Aircraft position marker">${PLANE_SVG}</div><div class="plane-icon-label" aria-hidden="true"></div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  };
  iconOptionsCache.set(key, options);
  return options;
}

interface MarkerEntry {
  marker: L.Marker;
  // Latest position this marker was drawn with — what a click selects.
  // The click handler used to capture the LiveMarker from when the marker
  // was first built, so selecting a long-lived marker flew to wherever the
  // aircraft was back then.
  latest: LiveMarker;
  headingRef: { current: number };
  callsignRef: { current: string };
  // (known, selected, roundedZoom, exiting) only — excludes `entering`,
  // which is true exactly once (this entry's first build) and never a
  // trigger for rebuilding afterward. Matches AircraftMarker's own
  // useMemo deps in the original React component.
  compareKey: string;
  // Last values written to the DOM, so an unchanged aircraft costs nothing
  // on a re-render (setLatLng and the glyph lookup each touch layout).
  lat: number;
  lon: number;
  rotationDeg: number;
  selected: boolean;
  dimmed: boolean;
}

function compareKey(known: boolean, selected: boolean, zoom: number, exiting: boolean, dimmed: boolean): string {
  return `${known}|${selected}|${zoom}|${exiting}|${dimmed}`;
}

// Below the normal z-order (0) so a dimmed ghost never paints over live traffic.
const DIMMED_Z_OFFSET = -1000;
const SELECTED_Z_OFFSET = 10_000;
function zOffset(selected: boolean, dimmed: boolean): number {
  return selected ? SELECTED_Z_OFFSET : dimmed ? DIMMED_Z_OFFSET : 0;
}

// Same tuple minus zoom: when only the zoom changed, the icon's markup is
// identical and just its size differs — see resizeInPlace.
function styleKey(key: string): string {
  const [known, selected, , exiting, dimmed] = key.split("|");
  return `${known}|${selected}|${exiting}|${dimmed}`;
}

/**
 * Applies a new icon size to an already-mounted marker element — the same
 * width/height/margins L.DivIcon's own _setIconStyles writes — instead of
 * handing the marker a new icon, which tears down and rebuilds its DOM.
 * Every zoom step used to rebuild every visible plane that way. Also
 * updates the marker's icon options so a later rebuild (or Leaflet's own
 * re-render) keeps the new size.
 */
function resizeInPlace(marker: L.Marker, options: L.DivIconOptions): boolean {
  const el = marker.getElement();
  const size = options.iconSize as [number, number] | undefined;
  const anchor = options.iconAnchor as [number, number] | undefined;
  if (!el || !size || !anchor) return false;
  el.style.width = `${size[0]}px`;
  el.style.height = `${size[1]}px`;
  el.style.marginLeft = `${-anchor[0]}px`;
  el.style.marginTop = `${-anchor[1]}px`;
  const icon = marker.options.icon as L.DivIcon | undefined;
  if (icon) {
    icon.options.iconSize = options.iconSize;
    icon.options.iconAnchor = options.iconAnchor;
  }
  return true;
}

export interface MarkerLayerUpdate {
  /** Unselected aircraft to draw as individual markers (empty when clustered). */
  unselected: LiveMarker[];
  selectedPos: SelectedPosition | null;
  zoom: number;
  /** Below CLUSTER_FETCH_MAX_ZOOM: fade unselected markers out rather than cutting them. */
  exiting: boolean;
  /** icao24s of unselected aircraft to draw dimmed (reports older than 2 h). Never applied to the selected one. */
  dimmed?: ReadonlySet<string>;
}

// Most aircraft that may fade in together; a bigger batch appears at once.
const MAX_FADE_IN_BATCH = 40;

export interface MarkerLayerHandle {
  update(params: MarkerLayerUpdate): void;
  destroy(): void;
}

/**
 * Owns every aircraft marker, reused by icao24 across ticks — never torn
 * down and rebuilt just because a position changed. A single entry can
 * move between "selected" and "unselected" (the aircraft gets clicked, or
 * the selection moves elsewhere) without ever being removed from the map;
 * only its icon options and z-order change.
 */
export function createMarkerLayer(map: L.Map, onSelect: (p: LiveMarker) => void): MarkerLayerHandle {
  const entries = new Map<string, MarkerEntry>();

  function buildEntry(p: LiveMarker, selected: boolean, roundedZoom: number, exiting: boolean, dimmed: boolean, entering: boolean): MarkerEntry {
    const known = p.headingDeg != null;
    const headingRef = { current: known ? (p.headingDeg as number) : 0 };
    const callsignRef = { current: p.callsign?.trim() || p.icao24.toUpperCase() };
    const options = planeIconOptions(known, selected, roundedZoom, entering, exiting, dimmed);
    const icon = new RotatingPlaneIcon(options, headingRef, callsignRef);
    const marker = L.marker([p.latitude, p.longitude], { icon });
    const entry = {} as MarkerEntry;
    marker.on("click", () => onSelect(entry.latest));
    marker.addTo(map);
    if (selected || dimmed) marker.setZIndexOffset(zOffset(selected, dimmed));
    return Object.assign(entry, {
      marker,
      latest: p,
      headingRef,
      callsignRef,
      compareKey: compareKey(known, selected, roundedZoom, exiting, dimmed),
      lat: p.latitude,
      lon: p.longitude,
      rotationDeg: headingRef.current,
      selected,
      dimmed,
    });
  }

  function applyEntry(entry: MarkerEntry, p: LiveMarker, selected: boolean, roundedZoom: number, exiting: boolean, dimmed: boolean): void {
    const known = p.headingDeg != null;
    const rotationDeg = known ? (p.headingDeg as number) : 0;
    entry.latest = p;
    entry.headingRef.current = rotationDeg;
    if (p.latitude !== entry.lat || p.longitude !== entry.lon) {
      entry.marker.setLatLng([p.latitude, p.longitude]);
      entry.lat = p.latitude;
      entry.lon = p.longitude;
    }
    if (selected !== entry.selected || dimmed !== entry.dimmed) {
      entry.marker.setZIndexOffset(zOffset(selected, dimmed));
      entry.selected = selected;
      entry.dimmed = dimmed;
    }

    const nextKey = compareKey(known, selected, roundedZoom, exiting, dimmed);
    if (nextKey !== entry.compareKey) {
      const options = planeIconOptions(known, selected, roundedZoom, false, exiting, dimmed);
      if (styleKey(nextKey) === styleKey(entry.compareKey) && resizeInPlace(entry.marker, options)) {
        entry.compareKey = nextKey;
      } else {
        // Rebuilt icon picks the heading up from headingRef in createIcon.
        entry.marker.setIcon(new RotatingPlaneIcon(options, entry.headingRef, entry.callsignRef));
        entry.compareKey = nextKey;
        entry.rotationDeg = rotationDeg;
        return;
      }
    }
    if (rotationDeg !== entry.rotationDeg) {
      // Heading is applied directly to the mounted glyph, never by handing
      // the marker a new `icon` — that would trigger Marker.setIcon(), which
      // tears down and rebuilds the icon DOM on every single position tick.
      const glyph = entry.marker.getElement()?.querySelector<HTMLElement>(".plane-glyph");
      if (glyph) glyph.style.transform = `rotate(${rotationDeg}deg)`;
      entry.rotationDeg = rotationDeg;
    }
  }

  function update({ unselected, selectedPos, zoom, exiting, dimmed }: MarkerLayerUpdate): void {
    const roundedZoom = Math.round(zoom);
    const seen = new Set<string>();
    // A one-shot fade-in per marker is a compositor layer and an animation
    // each: fine for a few aircraft appearing, a long task for hundreds at
    // once (a zoom or a fetch that replaces most of the view), so a big
    // batch just appears.
    let arriving = 0;
    for (const p of unselected) if (!entries.has(p.icao24)) arriving++;
    const fadeIn = arriving <= MAX_FADE_IN_BATCH;

    for (const p of unselected) {
      const existing = entries.get(p.icao24);
      if (existing) {
        seen.add(p.icao24);
        applyEntry(existing, p, false, roundedZoom, exiting, dimmed?.has(p.icao24) ?? false);
      } else if (!exiting) {
        // Never build a marker just to fade it out: an exiting render only
        // fades what is already on the map.
        seen.add(p.icao24);
        entries.set(p.icao24, buildEntry(p, false, roundedZoom, exiting, dimmed?.has(p.icao24) ?? false, fadeIn));
      }
    }

    if (selectedPos) {
      seen.add(selectedPos.icao24);
      const existing = entries.get(selectedPos.icao24);
      // Selected marker never fades (exiting is always false for it).
      if (existing) applyEntry(existing, selectedPos, true, roundedZoom, false, false);
      else entries.set(selectedPos.icao24, buildEntry(selectedPos, true, roundedZoom, false, false, true));
    }

    for (const [icao24, entry] of entries) {
      if (!seen.has(icao24)) {
        entry.marker.remove();
        entries.delete(icao24);
      }
    }
  }

  function destroy(): void {
    for (const entry of entries.values()) entry.marker.remove();
    entries.clear();
  }

  return { update, destroy };
}
