import { Marker } from "maplibre-gl";
import type { FlightMap } from "./map";
import type { LiveMarker, SelectedPosition } from "../types/flight";

// A small rotated dart stands in for the transponder icon — heading comes
// straight off the state vector. Authored pointing straight up (north), so
// rotate(headingDeg) with no correction term is always correct by
// construction (see the original FlightMap.tsx PLANE_SVG comment for the
// emoji-glyph approach this replaced and why).
export const PLANE_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true">
  <path d="M12 2 L19 20 L12 16 L5 20 Z" />
</svg>`;

// Plane icon box size (px) per rounded zoom level, desktop. One number per
// zoom, so a size is easy to read and to tune. Overlapping planes are hidden
// (map/declutter.ts) rather than clustered, so icons are clearly bigger than
// the old 30-36 px dart, but they grow gradually from the world view up to
// city zoom (z14) and then taper again so that planes fit by their gates
// (stands are ~50 m apart, about 40 px at z16).
const ICON_SIZE_BY_ZOOM: readonly number[] = [
  /* z0  */ 18, 18, 20,
  /* z3  */ 22, 25, 28, 30, 33, 37,
  /* z9  */ 40, 43, 46, 50, 54,
  /* z14 */ 58,
  /* z15 */ 52,
  /* z16 */ 43,
  /* z17 */ 40,
  /* z18 */ 43,
];
const MOBILE_BREAKPOINT_PX = 768;
// Phones get larger targets for a finger.
const MOBILE_FACTOR = 1.2;
// The selected plane stands out by size as well as colour.
const SELECTED_FACTOR = 1.25;

function scaleIconSize(zoom: number, mobile: boolean, selected: boolean): number {
  const z = Math.max(0, Math.min(ICON_SIZE_BY_ZOOM.length - 1, Math.round(zoom)));
  return Math.round(ICON_SIZE_BY_ZOOM[z] * (mobile ? MOBILE_FACTOR : 1) * (selected ? SELECTED_FACTOR : 1));
}

/** The side of an unselected plane's icon box at this zoom, px (what overlap is measured against). */
export function planeBoxSize(zoom: number): number {
  const mobile = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT_PX}px)`).matches;
  return scaleIconSize(zoom, mobile, false);
}

interface IconParams {
  known: boolean;
  selected: boolean;
  zoom: number;
  entering: boolean;
  exiting: boolean;
  dimmed: boolean;
}

interface IconStyle {
  className: string;
  size: number;
}

// Icon styles are cacheable across markers sharing the same (known,
// selected, zoom, entering, exiting, dimmed) tuple.
const iconStyleCache = new Map<string, IconStyle>();

function planeIconStyle({ known, selected, zoom, entering, exiting, dimmed }: IconParams): IconStyle {
  const key = `${known}|${selected}|${zoom}|${entering}|${exiting}|${dimmed}`;
  const cached = iconStyleCache.get(key);
  if (cached) return cached;
  const isMobile = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT_PX}px)`).matches;
  const style = {
    className: `plane-icon${selected ? " plane-icon--selected" : ""}${entering ? " plane-icon--entering" : ""}${exiting ? " plane-icon--exiting" : ""}${dimmed ? " plane-icon--dimmed" : ""}`,
    size: Math.max(scaleIconSize(zoom, isMobile, selected), 16),
  };
  iconStyleCache.set(key, style);
  return style;
}

/**
 * Builds one plane's marker element: a bare wrapper that MapLibre positions
 * (its transform, opacity and z-index are the Marker's), holding the
 * `.plane-icon` box this file styles. The wrapper keeps MapLibre's inline
 * opacity off `.plane-icon`, where the dimmed/exiting rules need it. The
 * callsign is written with textContent, never interpolated into the markup,
 * since it is untrusted external OpenSky data.
 */
function buildPlaneElement(known: boolean, headingDeg: number, callsign: string): { root: HTMLElement; icon: HTMLElement; glyph: HTMLElement } {
  const root = document.createElement("div");
  root.className = "plane-marker";
  const icon = document.createElement("div");
  const glyphClass = known ? "plane-glyph" : "plane-glyph plane-glyph--unknown-heading";
  icon.innerHTML = `<div class="plane-icon-halo" aria-hidden="true"></div><div class="plane-icon-mark" aria-hidden="true"></div><div class="${glyphClass}" role="img" aria-label="Aircraft position marker">${PLANE_SVG}</div><div class="plane-icon-label" aria-hidden="true"></div>`;
  const glyph = icon.querySelector<HTMLElement>(".plane-glyph")!;
  glyph.style.transform = `rotate(${headingDeg}deg)`;
  icon.querySelector<HTMLElement>(".plane-icon-label")!.textContent = callsign;
  root.appendChild(icon);
  return { root, icon, glyph };
}

function applyIconStyle(icon: HTMLElement, style: IconStyle): void {
  icon.className = style.className;
  icon.style.width = `${style.size}px`;
  icon.style.height = `${style.size}px`;
}

interface MarkerEntry {
  marker: Marker;
  root: HTMLElement;
  icon: HTMLElement;
  glyph: HTMLElement;
  // Latest position this marker was drawn with — what a click selects.
  // The click handler used to capture the LiveMarker from when the marker
  // was first built, so selecting a long-lived marker flew to wherever the
  // aircraft was back then.
  latest: LiveMarker;
  // (known, selected, roundedZoom, exiting, dimmed) only — excludes
  // `entering`, which is true exactly once (this entry's first build) and
  // never a trigger for restyling afterward.
  compareKey: string;
  // Last values written to the DOM, so an unchanged aircraft costs nothing
  // on a re-render (setLngLat and the glyph transform each touch layout).
  known: boolean;
  lat: number;
  lon: number;
  rotationDeg: number;
  selected: boolean;
  dimmed: boolean;
}

function compareKey(known: boolean, selected: boolean, zoom: number, exiting: boolean, dimmed: boolean): string {
  return `${known}|${selected}|${zoom}|${exiting}|${dimmed}`;
}

// Stacking among markers (they share one container with the GL canvas, so
// no negative values: those would drop below the map). A dimmed ghost
// never paints over live traffic; the selected plane is always on top.
function zIndex(selected: boolean, dimmed: boolean): string {
  return selected ? "2" : dimmed ? "0" : "1";
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
 * only its classes, size and z-order change.
 */
export function createMarkerLayer(map: FlightMap, onSelect: (p: LiveMarker) => void): MarkerLayerHandle {
  const entries = new Map<string, MarkerEntry>();

  function buildEntry(p: LiveMarker, selected: boolean, roundedZoom: number, exiting: boolean, dimmed: boolean, entering: boolean): MarkerEntry {
    const known = p.headingDeg != null;
    const rotationDeg = known ? (p.headingDeg as number) : 0;
    const { root, icon, glyph } = buildPlaneElement(known, rotationDeg, p.callsign?.trim() || p.icao24.toUpperCase());
    applyIconStyle(icon, planeIconStyle({ known, selected, zoom: roundedZoom, entering, exiting, dimmed }));
    root.style.zIndex = zIndex(selected, dimmed);
    const entry = {} as MarkerEntry;
    root.addEventListener("click", (e) => {
      e.stopPropagation();
      onSelect(entry.latest);
    });
    const marker = new Marker({ element: root, anchor: "center" }).setLngLat([p.longitude, p.latitude]).addTo(map.gl);
    // Test-only hook: the scenario harness reads each drawn plane's true
    // position from its element (see tests/scenarios/harness.ts planeMarkers).
    (root as unknown as { _marker: Marker })._marker = marker;
    return Object.assign(entry, {
      marker,
      root,
      icon,
      glyph,
      latest: p,
      compareKey: compareKey(known, selected, roundedZoom, exiting, dimmed),
      known,
      lat: p.latitude,
      lon: p.longitude,
      rotationDeg,
      selected,
      dimmed,
    });
  }

  function applyEntry(entry: MarkerEntry, p: LiveMarker, selected: boolean, roundedZoom: number, exiting: boolean, dimmed: boolean): void {
    const known = p.headingDeg != null;
    const rotationDeg = known ? (p.headingDeg as number) : 0;
    entry.latest = p;
    if (p.latitude !== entry.lat || p.longitude !== entry.lon) {
      entry.marker.setLngLat([p.longitude, p.latitude]);
      entry.lat = p.latitude;
      entry.lon = p.longitude;
    }
    if (selected !== entry.selected || dimmed !== entry.dimmed) {
      entry.root.style.zIndex = zIndex(selected, dimmed);
      entry.selected = selected;
      entry.dimmed = dimmed;
    }
    const nextKey = compareKey(known, selected, roundedZoom, exiting, dimmed);
    if (nextKey !== entry.compareKey) {
      // Restyled in place (classes and size): the element itself, and the
      // Marker holding it, live as long as the aircraft is drawn.
      applyIconStyle(entry.icon, planeIconStyle({ known, selected, zoom: roundedZoom, entering: false, exiting, dimmed }));
      if (known !== entry.known) {
        entry.glyph.classList.toggle("plane-glyph--unknown-heading", !known);
        entry.known = known;
      }
      entry.compareKey = nextKey;
    }
    if (rotationDeg !== entry.rotationDeg) {
      entry.glyph.style.transform = `rotate(${rotationDeg}deg)`;
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
