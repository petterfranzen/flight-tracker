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

const ICON_SIZE = 30;
const SELECTED_ICON_SIZE = 44;
const MOBILE_BREAKPOINT_PX = 768;
const MOBILE_ICON_SIZE = 40;
const MOBILE_SELECTED_ICON_SIZE = 54;

// Aircraft icons shrink toward this floor as you zoom out; full size from
// FULL_SIZE_ZOOM (== SELECTED_MIN_ZOOM in map.ts) upward.
const MIN_ICON_SIZE_PX = 9;
const FULL_SIZE_ZOOM = 10;

function scaleIconSize(base: number, zoom: number): number {
  if (zoom >= FULL_SIZE_ZOOM) return base;
  const t = Math.max(0, zoom) / FULL_SIZE_ZOOM;
  return Math.round(MIN_ICON_SIZE_PX + (base - MIN_ICON_SIZE_PX) * t);
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
}

function iconParamsKey(p: IconParams): string {
  return `${p.known}|${p.selected}|${p.zoom}|${p.entering}|${p.exiting}`;
}

// Icon *options* (className/html/size) are cacheable across markers sharing
// the same (known, selected, zoom, entering, exiting) tuple — only
// headingRef/callsignRef need to stay per-marker (see RotatingPlaneIcon's
// own comment), so each marker still gets its own icon instance built from
// these shared, immutable options.
const iconOptionsCache = new Map<string, L.DivIconOptions>();

function planeIconOptions(known: boolean, selected: boolean, zoom: number, entering: boolean, exiting: boolean): L.DivIconOptions {
  const key = iconParamsKey({ known, selected, zoom, entering, exiting });
  const cached = iconOptionsCache.get(key);
  if (cached) return cached;

  const glyphClass = known ? "plane-glyph" : "plane-glyph plane-glyph--unknown-heading";
  const isMobile = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT_PX}px)`).matches;
  const baseSize = selected ? (isMobile ? MOBILE_SELECTED_ICON_SIZE : SELECTED_ICON_SIZE) : isMobile ? MOBILE_ICON_SIZE : ICON_SIZE;
  const size = selected ? Math.max(scaleIconSize(baseSize, zoom), 16) : scaleIconSize(baseSize, zoom);

  const options: L.DivIconOptions = {
    className: `plane-icon${selected ? " plane-icon--selected" : ""}${entering ? " plane-icon--entering" : ""}${exiting ? " plane-icon--exiting" : ""}`,
    html: `<div class="plane-icon-halo" aria-hidden="true"></div><div class="plane-icon-mark" aria-hidden="true"></div><div class="${glyphClass}" role="img" aria-label="Aircraft position marker">${PLANE_SVG}</div><div class="plane-icon-label" aria-hidden="true"></div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  };
  iconOptionsCache.set(key, options);
  return options;
}

interface MarkerEntry {
  marker: L.Marker;
  headingRef: { current: number };
  callsignRef: { current: string };
  // (known, selected, roundedZoom, exiting) only — excludes `entering`,
  // which is true exactly once (this entry's first build) and never a
  // trigger for rebuilding afterward. Matches AircraftMarker's own
  // useMemo deps in the original React component.
  compareKey: string;
}

function compareKey(known: boolean, selected: boolean, zoom: number, exiting: boolean): string {
  return `${known}|${selected}|${zoom}|${exiting}`;
}

export interface MarkerLayerUpdate {
  /** Unselected aircraft to draw as individual markers (empty when clustered). */
  unselected: LiveMarker[];
  selectedPos: SelectedPosition | null;
  zoom: number;
  /** Below CLUSTER_FETCH_MAX_ZOOM: fade unselected markers out rather than cutting them. */
  exiting: boolean;
}

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

  function buildEntry(p: LiveMarker, selected: boolean, roundedZoom: number, exiting: boolean): MarkerEntry {
    const known = p.headingDeg != null;
    const headingRef = { current: known ? (p.headingDeg as number) : 0 };
    const callsignRef = { current: p.callsign?.trim() || p.icao24.toUpperCase() };
    const options = planeIconOptions(known, selected, roundedZoom, true, exiting);
    const icon = new RotatingPlaneIcon(options, headingRef, callsignRef);
    const marker = L.marker([p.latitude, p.longitude], { icon });
    marker.on("click", () => onSelect(p));
    marker.addTo(map);
    return { marker, headingRef, callsignRef, compareKey: compareKey(known, selected, roundedZoom, exiting) };
  }

  function applyEntry(entry: MarkerEntry, p: LiveMarker, selected: boolean, roundedZoom: number, exiting: boolean): void {
    const known = p.headingDeg != null;
    const rotationDeg = known ? (p.headingDeg as number) : 0;
    entry.headingRef.current = rotationDeg;
    entry.marker.setLatLng([p.latitude, p.longitude]);
    entry.marker.setZIndexOffset(selected ? 10_000 : 0);

    // Heading is applied directly to the mounted glyph, never by handing
    // the marker a new `icon` — that would trigger Marker.setIcon(), which
    // tears down and rebuilds the icon DOM on every single position tick.
    const glyph = entry.marker.getElement()?.querySelector<HTMLElement>(".plane-glyph");
    if (glyph) glyph.style.transform = `rotate(${rotationDeg}deg)`;

    const nextKey = compareKey(known, selected, roundedZoom, exiting);
    if (nextKey !== entry.compareKey) {
      const options = planeIconOptions(known, selected, roundedZoom, false, exiting);
      entry.marker.setIcon(new RotatingPlaneIcon(options, entry.headingRef, entry.callsignRef));
      entry.compareKey = nextKey;
    }
  }

  function update({ unselected, selectedPos, zoom, exiting }: MarkerLayerUpdate): void {
    const roundedZoom = Math.round(zoom);
    const seen = new Set<string>();

    for (const p of unselected) {
      seen.add(p.icao24);
      const existing = entries.get(p.icao24);
      if (existing) applyEntry(existing, p, false, roundedZoom, exiting);
      else entries.set(p.icao24, buildEntry(p, false, roundedZoom, exiting));
    }

    if (selectedPos) {
      seen.add(selectedPos.icao24);
      const existing = entries.get(selectedPos.icao24);
      // Selected marker never fades (exiting is always false for it).
      if (existing) applyEntry(existing, selectedPos, true, roundedZoom, false);
      else entries.set(selectedPos.icao24, buildEntry(selectedPos, true, roundedZoom, false));
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
