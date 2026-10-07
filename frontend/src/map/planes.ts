import type { ExpressionSpecification, GeoJSONSource } from "maplibre-gl";
import type { FlightMap, MapHit, Point, RenderedPlane } from "./map";
import type { LiveMarker, SelectedPosition } from "../types/flight";
import { canvas, cssToken, drawLabel, measureLabel, serveImages, withAlpha, type DrawnImage, type LabelStyle } from "./glImages";
import { isSmallScreen } from "./screen";

// Planes are drawn by the map itself: a GeoJSON source and symbol layers,
// one feature per drawn plane, rotated to its heading on the GPU. Which
// planes are drawn (overlap hiding, the caps) is decided in main.ts
// (map/declutter.ts); this file draws exactly that set.

// The dart: authored pointing straight up (north) in a 24-unit box, so
// icon-rotate = heading with no correction term is correct by construction.
const PLANE_PATH = "M12 2 L19 20 L12 16 L5 20 Z";

// Plane icon box size (px) per zoom level, desktop. One number per zoom, so
// a size is easy to read and to tune; between levels the map interpolates
// (zoom is continuous). Overlapping planes are hidden (map/declutter.ts)
// rather than clustered, so icons are clearly bigger than the old 30-36 px
// dart, but they grow gradually from the world view up to city zoom (z14)
// and then taper again so that planes fit by their gates (stands are ~50 m
// apart, about 40 px at z16).
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
// Phones get larger targets for a finger.
const MOBILE_FACTOR = 1.2;
// The selected plane stands out by size as well as colour.
const SELECTED_FACTOR = 1.25;

function levelSize(level: number, mobile: boolean, selected: boolean): number {
  const z = Math.max(0, Math.min(ICON_SIZE_BY_ZOOM.length - 1, level));
  return Math.max(16, Math.round(ICON_SIZE_BY_ZOOM[z] * (mobile ? MOBILE_FACTOR : 1) * (selected ? SELECTED_FACTOR : 1)));
}

/** A plane's icon box side at this (app, fractional) zoom, px: the per-level sizes, linear in between. */
export function planeIconSize(zoom: number, mobile: boolean, selected: boolean): number {
  const lo = Math.floor(zoom);
  const t = zoom - lo;
  return levelSize(lo, mobile, selected) * (1 - t) + levelSize(lo + 1, mobile, selected) * t;
}

/** The side of an unselected plane's icon box at this zoom, px (what overlap is measured against). */
export function planeBoxSize(zoom: number): number {
  return planeIconSize(zoom, isSmallScreen(), false);
}

// The plane images are drawn on a box of this many CSS px (at IMAGE_RATIO
// device px each) and scaled to the size above with icon-size.
const IMAGE_PX = 64;
const IMAGE_RATIO = 3;
// MapLibre's zoom is the app's minus one (512 px tiles; see map/map.ts).
const GL_ZOOM_OFFSET = 1;

/** `fn(size at each zoom level)` as a MapLibre zoom expression, interpolated between levels. */
function byZoom(fn: (size: number) => number | number[], mobile: boolean, selected: boolean): ExpressionSpecification {
  const stops: unknown[] = [];
  for (let z = 0; z < ICON_SIZE_BY_ZOOM.length; z++) {
    const v = fn(levelSize(z, mobile, selected));
    stops.push(z - GL_ZOOM_OFFSET, Array.isArray(v) ? ["literal", v] : v);
  }
  return ["interpolate", ["linear"], ["zoom"], ...stops] as unknown as ExpressionSpecification;
}

// Data-driven in form only (every feature's `scale` is absent: 1). A plain
// zoom expression is capped by MapLibre at its value one level above the
// tile's (what collision boxes are built for), which drew the planes that
// shrink past z14 a level early; a feature-and-zoom size is not capped.
const iconSize = (mobile: boolean, selected: boolean): ExpressionSpecification => {
  const expr = byZoom((size) => size / IMAGE_PX, mobile, selected) as unknown[];
  for (let i = 4; i < expr.length; i += 2) expr[i] = ["*", expr[i], ["coalesce", ["get", "scale"], 1]];
  return expr as ExpressionSpecification;
};
// The callsign chip starts 4 px right of the selected plane's box.
const labelTranslate = (mobile: boolean) => byZoom((size) => [size / 2 + 4, 0], mobile, true);

interface PlaneColors {
  marker: string;
  selected: string;
  outline: string;
  shadow: string;
}

/**
 * The dart on a transparent IMAGE_PX box, as the DOM marker drew it: the
 * path fills 90% of the box, a dark outline and drop shadow keep it legible
 * over any basemap. An unknown heading (no rotation can say "unknown") is a
 * dashed outline instead of a filled dart.
 */
function drawPlane(fill: string, c: PlaneColors, unknownHeading: boolean): DrawnImage {
  const { ctx, done } = canvas(IMAGE_PX, IMAGE_PX, IMAGE_RATIO);
  const unit = (IMAGE_PX * 0.9) / 24;
  ctx.translate(IMAGE_PX * 0.05, IMAGE_PX * 0.05);
  ctx.scale(unit, unit);
  const path = new Path2D(PLANE_PATH);
  ctx.lineJoin = "round";
  ctx.lineWidth = 1;
  ctx.shadowColor = c.shadow;
  ctx.shadowOffsetY = 1.6 * IMAGE_RATIO;
  ctx.shadowBlur = 3 * IMAGE_RATIO;
  if (unknownHeading) {
    ctx.globalAlpha = 0.75;
    ctx.setLineDash([2, 2]);
    ctx.strokeStyle = c.marker;
    ctx.stroke(path);
  } else {
    ctx.fillStyle = fill;
    ctx.fill(path);
    ctx.shadowColor = "transparent";
    ctx.strokeStyle = c.outline;
    ctx.stroke(path);
  }
  return done();
}

/** The selected plane's halo: a soft disc behind it, unrotated. */
function drawHalo(color: string): DrawnImage {
  const { ctx, done } = canvas(IMAGE_PX, IMAGE_PX, IMAGE_RATIO);
  const r = IMAGE_PX / 2;
  // As the CSS radial-gradient(circle, c 0%, transparent 72%) clipped to the box's circle did.
  const g = ctx.createRadialGradient(r, r, 0, r, r, 0.72 * Math.SQRT2 * r);
  g.addColorStop(0, withAlpha(color, 0.55));
  g.addColorStop(1, withAlpha(color, 0));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(r, r, r, 0, 2 * Math.PI);
  ctx.fill();
  return done();
}

export const PLANES_SOURCE = "planes";
export const SELECTED_SOURCE = "plane-selected";
/** Bottom of the plane layers: anything drawn under the planes (the trail, airports) is added before it. */
export const PLANES_LAYER = "planes";
const ENTERING_LAYER = "planes-entering";
const HALO_LAYER = "plane-selected-halo";
const SELECTED_LAYER = "plane-selected";
const LABEL_LAYER = "plane-selected-label";
const LABEL_PREFIX = "plane-label:";

// A report older than 2 h (map/staleness.ts) is drawn at this opacity.
const DIMMED_OPACITY = 0.35;
// The selected plane's halo, as the reduced-motion look of the DOM marker's pulse.
const HALO_OPACITY = 0.6;

export interface PlaneLayerUpdate {
  /** Unselected aircraft to draw. */
  unselected: LiveMarker[];
  selectedPos: SelectedPosition | null;
  /** icao24s of unselected aircraft to draw dimmed (reports older than 2 h). Never applied to the selected one. */
  dimmed?: ReadonlySet<string>;
}

export interface PlaneLayerHandle {
  update(params: PlaneLayerUpdate): void;
  destroy(): void;
}

// Most aircraft that may fade in together; a bigger batch appears at once.
const MAX_FADE_IN_BATCH = 40;
const FADE_IN_MS = 220;

interface PlaneProps {
  id: string;
  cs: string;
  known: boolean;
  rot: number;
  dimmed: boolean;
  entering: boolean;
  /** Draw order: dimmed ghosts under live traffic. */
  sort: number;
}

const displayCallsign = (p: LiveMarker): string => p.callsign?.trim() || p.icao24.toUpperCase();

function props(p: LiveMarker, dimmed: boolean, entering: boolean): PlaneProps {
  const known = p.headingDeg != null;
  return { id: p.icao24, cs: displayCallsign(p), known, rot: known ? (p.headingDeg as number) : 0, dimmed, entering, sort: dimmed ? 0 : 1 };
}

function feature(p: LiveMarker, properties: object): GeoJSON.Feature<GeoJSON.Point> {
  return { type: "Feature", properties, geometry: { type: "Point", coordinates: [p.longitude, p.latitude] } };
}

/**
 * Draws the planes main.ts picks: unselected ones in one source (re-sent
 * with setData only when something drawn changed, never per frame), the
 * selected one in its own, drawn on top with a halo and its callsign chip.
 * Clicks and hovers are hit-tested against what the map rendered.
 */
export function createPlaneLayer(map: FlightMap, onSelect: (p: LiveMarker) => void): PlaneLayerHandle {
  const gl = map.gl;
  let added = false;
  let destroyed = false;
  // Everything drawn (selected included), by icao24: what a click selects.
  // Holds the latest position, not the one a plane was first drawn with.
  const latest = new Map<string, LiveMarker>();
  // Drawn planes that arrived in a small batch and faded in.
  const fadedIn = new Set<string>();
  // When each drawn plane was last added to the drawn set (for tests).
  const drawnSince = new Map<string, number>();
  let entering = new Set<string>();
  let unselectedData: GeoJSON.Feature[] = [];
  let unselectedKey = new Map<string, string>();
  let selectedData: GeoJSON.Feature[] = [];
  let selectedKey = "";
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const mobileQuery = window.matchMedia("(max-width: 768px)");

  map.whenStyleReady(() => {
    if (added || destroyed) return;
    const colors: PlaneColors = {
      marker: cssToken("--color-marker", "#3ce0ff"),
      selected: cssToken("--color-marker-selected", "#ffb63c"),
      outline: cssToken("--color-plane-outline", "rgba(0, 0, 0, 0.7)"),
      shadow: cssToken("--color-plane-shadow", "rgba(0, 0, 0, 0.6)"),
    };
    const add = (id: string, img: DrawnImage): void => {
      gl.addImage(id, img.data, { pixelRatio: img.pixelRatio });
    };
    add("plane", drawPlane(colors.marker, colors, false));
    add("plane-selected", drawPlane(colors.selected, colors, false));
    add("plane-unknown", drawPlane(colors.marker, colors, true));
    add("plane-halo", drawHalo(cssToken("--color-marker-halo", "#4db2ff")));

    const labelStyle: LabelStyle = {
      font: `700 11px ${cssToken("--font-data", "monospace")}`,
      color: colors.selected,
      background: cssToken("--color-label-bg", "rgba(5, 6, 8, 0.65)"),
      padX: 4,
      padY: 1,
      radius: 0,
      letterSpacing: "0.11px",
    };
    serveImages(
      map,
      LABEL_PREFIX,
      (text) => {
        const { width, height } = measureLabel(text, labelStyle);
        const { ctx, done } = canvas(width, height, Math.max(2, window.devicePixelRatio || 1));
        drawLabel(ctx, text, labelStyle, 0, 0);
        return done();
      },
      labelStyle.font,
    );

    const mobile = mobileQuery.matches;
    gl.addSource(PLANES_SOURCE, { type: "geojson", data: { type: "FeatureCollection", features: unselectedData } });
    gl.addSource(SELECTED_SOURCE, { type: "geojson", data: { type: "FeatureCollection", features: selectedData } });
    const planeLayout = (selected: boolean) => ({
      "icon-image": (selected
        ? ["case", ["get", "known"], "plane-selected", "plane-unknown"]
        : ["case", ["get", "known"], "plane", "plane-unknown"]) as ExpressionSpecification,
      "icon-rotate": ["get", "rot"] as ExpressionSpecification,
      "icon-rotation-alignment": "map" as const,
      "icon-size": iconSize(mobile, selected),
      // Overlap is already decided (map/declutter.ts): draw every feature.
      "icon-allow-overlap": true,
      "icon-ignore-placement": true,
    });
    gl.addLayer({
      id: PLANES_LAYER,
      type: "symbol",
      source: PLANES_SOURCE,
      filter: ["!", ["get", "entering"]],
      layout: { ...planeLayout(false), "symbol-sort-key": ["get", "sort"] },
      paint: { "icon-opacity": ["case", ["get", "dimmed"], DIMMED_OPACITY, 1] },
    });
    // A small batch of new arrivals, faded in together (see fadeIn).
    gl.addLayer({ id: ENTERING_LAYER, type: "symbol", source: PLANES_SOURCE, filter: ["get", "entering"], layout: planeLayout(false), paint: { "icon-opacity": 1 } });
    gl.addLayer({
      id: HALO_LAYER,
      type: "symbol",
      source: SELECTED_SOURCE,
      layout: { "icon-image": "plane-halo", "icon-size": iconSize(mobile, true), "icon-allow-overlap": true, "icon-ignore-placement": true },
      paint: { "icon-opacity": HALO_OPACITY },
    });
    gl.addLayer({ id: SELECTED_LAYER, type: "symbol", source: SELECTED_SOURCE, layout: planeLayout(true) });
    gl.addLayer({
      id: LABEL_LAYER,
      type: "symbol",
      source: SELECTED_SOURCE,
      layout: {
        "icon-image": ["concat", LABEL_PREFIX, ["get", "cs"]],
        "icon-anchor": "left",
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
      },
      // A paint property, so the gap to the plane follows its size every frame of a zoom.
      paint: { "icon-translate": labelTranslate(mobile), "icon-translate-anchor": "viewport" },
    });
    added = true;
  });

  // A phone-width window (or a resize into one) gets the larger sizes.
  function applyScreenSize(): void {
    if (!added) return;
    const mobile = mobileQuery.matches;
    for (const id of [PLANES_LAYER, ENTERING_LAYER]) gl.setLayoutProperty(id, "icon-size", iconSize(mobile, false));
    for (const id of [HALO_LAYER, SELECTED_LAYER]) gl.setLayoutProperty(id, "icon-size", iconSize(mobile, true));
    gl.setPaintProperty(LABEL_LAYER, "icon-translate", labelTranslate(mobile));
  }
  mobileQuery.addEventListener("change", applyScreenSize);

  function setUnselected(features: GeoJSON.Feature[]): void {
    unselectedData = features;
    if (added) (gl.getSource(PLANES_SOURCE) as GeoJSONSource).setData({ type: "FeatureCollection", features });
  }

  // ---- fade-in ----
  // The entering layer's opacity runs 0 -> 1 once its features are on screen
  // (setData lands a frame or more later, in the worker), then the batch
  // joins the main layer. A few frames of setPaintProperty, never setData.
  let fadeFrame = 0;
  let fadeTimeout: ReturnType<typeof setTimeout> | null = null;
  function fadeIn(): void {
    stopFade();
    if (!added) return finishFade();
    gl.setPaintProperty(ENTERING_LAYER, "icon-opacity", 0);
    let start = 0;
    const waitUntil = performance.now() + 1_000;
    const step = (now: number): void => {
      if (!start) {
        if (gl.queryRenderedFeatures({ layers: [ENTERING_LAYER] }).length === 0 && now < waitUntil) {
          fadeFrame = requestAnimationFrame(step);
          return;
        }
        start = now;
      }
      const t = Math.min(1, (now - start) / FADE_IN_MS);
      gl.setPaintProperty(ENTERING_LAYER, "icon-opacity", t);
      if (t < 1) fadeFrame = requestAnimationFrame(step);
      else finishFade();
    };
    fadeFrame = requestAnimationFrame(step);
    // A hidden tab runs no frames: don't leave the batch transparent.
    fadeTimeout = setTimeout(finishFade, 1_000 + FADE_IN_MS + 500);
  }
  function stopFade(): void {
    if (fadeFrame) cancelAnimationFrame(fadeFrame);
    fadeFrame = 0;
    if (fadeTimeout) clearTimeout(fadeTimeout);
    fadeTimeout = null;
  }
  function finishFade(): void {
    stopFade();
    if (added) gl.setPaintProperty(ENTERING_LAYER, "icon-opacity", 1);
    if (entering.size === 0) return;
    entering = new Set();
    setUnselected(unselectedData.map((f) => ((f.properties as PlaneProps).entering ? { ...f, properties: { ...f.properties, entering: false } } : f)));
  }

  function update({ unselected, selectedPos, dimmed }: PlaneLayerUpdate): void {
    // Arrivals: not drawn last time (selected or not). A one-shot fade-in for
    // a few aircraft appearing; a zoom or a fetch that replaces most of the
    // view just appears.
    const arriving = unselected.filter((p) => !latest.has(p.icao24));
    const fade = arriving.length > 0 && arriving.length <= MAX_FADE_IN_BATCH && !reducedMotion.matches;
    for (const p of arriving) {
      if (fade) fadedIn.add(p.icao24);
      else fadedIn.delete(p.icao24);
    }
    // A new batch replaces one still fading in (that one is shown in full).
    // A dimmed plane has an opacity of its own, so it never fades.
    const nextEntering = new Set<string>();
    if (fade) stopFade();
    for (const p of fade ? arriving : unselected) {
      if ((fade || entering.has(p.icao24)) && !dimmed?.has(p.icao24)) nextEntering.add(p.icao24);
    }

    const nextKey = new Map<string, string>();
    const features: GeoJSON.Feature[] = [];
    let changed = nextEntering.size !== entering.size || [...nextEntering].some((id) => !entering.has(id));
    for (const p of unselected) {
      const pr = props(p, dimmed?.has(p.icao24) ?? false, nextEntering.has(p.icao24));
      const key = `${p.latitude},${p.longitude},${pr.rot},${pr.known},${pr.cs},${pr.dimmed}`;
      nextKey.set(p.icao24, key);
      if (unselectedKey.get(p.icao24) !== key) changed = true;
      features.push(feature(p, pr));
    }
    if (nextKey.size !== unselectedKey.size) changed = true;
    unselectedKey = nextKey;
    entering = nextEntering;
    if (changed) setUnselected(features);

    const sKey = selectedPos ? `${selectedPos.icao24},${selectedPos.latitude},${selectedPos.longitude},${selectedPos.headingDeg},${displayCallsign(selectedPos)}` : "";
    if (sKey !== selectedKey) {
      selectedKey = sKey;
      selectedData = selectedPos ? [feature(selectedPos, props(selectedPos, false, false))] : [];
      if (added) (gl.getSource(SELECTED_SOURCE) as GeoJSONSource).setData({ type: "FeatureCollection", features: selectedData });
    }

    const drawn = new Map<string, LiveMarker>();
    for (const p of unselected) drawn.set(p.icao24, p);
    if (selectedPos) {
      if (!latest.has(selectedPos.icao24)) fadedIn.delete(selectedPos.icao24);
      drawn.set(selectedPos.icao24, selectedPos);
    }
    for (const id of fadedIn) if (!drawn.has(id)) fadedIn.delete(id);
    const now = performance.now();
    for (const id of drawn.keys()) if (!latest.has(id)) drawnSince.set(id, now);
    for (const id of drawnSince.keys()) if (!drawn.has(id)) drawnSince.delete(id);
    latest.clear();
    for (const [id, p] of drawn) latest.set(id, p);

    if (fade && entering.size > 0) fadeIn();
  }

  // ---- hit testing and the test hook ----
  const planeLayers = [SELECTED_LAYER, PLANES_LAYER, ENTERING_LAYER];

  map.addHitTarget((pt: Point): MapHit | null => {
    if (!added) return null;
    const mobile = mobileQuery.matches;
    const zoom = map.getZoom();
    // The whole icon box is the click target, as the DOM marker's was.
    const half = planeIconSize(zoom, mobile, false) / 2;
    const halfSelected = planeIconSize(zoom, mobile, true) / 2;
    let best: MapHit | null = null;
    for (const f of gl.queryRenderedFeatures(
      [
        [pt.x - halfSelected, pt.y - halfSelected],
        [pt.x + halfSelected, pt.y + halfSelected],
      ],
      { layers: planeLayers },
    )) {
      const id = f.properties.id as string;
      const p = latest.get(id);
      if (!p) continue;
      const selected = f.layer.id === SELECTED_LAYER;
      const at = map.project(p.latitude, p.longitude);
      const dx = Math.abs(at.x - pt.x);
      const dy = Math.abs(at.y - pt.y);
      const reach = selected ? halfSelected : half;
      if (dx > reach || dy > reach) continue;
      const hit: MapHit = { id: `plane:${id}`, priority: selected ? 0 : 1, distance: Math.hypot(dx, dy), activate: () => onSelect(latest.get(id) ?? p) };
      if (!best || hit.priority < best.priority || (hit.priority === best.priority && hit.distance < best.distance)) best = hit;
    }
    return best;
  });

  map.renderedPlanes = (): RenderedPlane[] => {
    if (!added) return [];
    const mobile = mobileQuery.matches;
    const zoom = map.getZoom();
    const out = new Map<string, RenderedPlane>();
    for (const f of gl.queryRenderedFeatures({ layers: planeLayers })) {
      const pr = f.properties as PlaneProps;
      const selected = f.layer.id === SELECTED_LAYER;
      if (out.has(pr.id) && !selected) continue;
      const [lon, lat] = (f.geometry as GeoJSON.Point).coordinates;
      const at = map.project(lat, lon);
      out.set(pr.id, {
        icao24: pr.id,
        callsign: pr.cs,
        lat,
        lon,
        x: at.x,
        y: at.y,
        size: planeIconSize(zoom, mobile, selected),
        selected,
        dimmed: !selected && pr.dimmed,
        label: selected ? pr.cs : null,
        fadedIn: fadedIn.has(pr.id),
        drawnSince: drawnSince.get(pr.id) ?? 0,
      });
    }
    return Array.from(out.values());
  };

  function destroy(): void {
    destroyed = true;
    stopFade();
    mobileQuery.removeEventListener("change", applyScreenSize);
    if (added && gl.getStyle()) {
      for (const id of [LABEL_LAYER, SELECTED_LAYER, HALO_LAYER, ENTERING_LAYER, PLANES_LAYER]) gl.removeLayer(id);
      gl.removeSource(PLANES_SOURCE);
      gl.removeSource(SELECTED_SOURCE);
    }
    added = false;
    latest.clear();
  }

  return { update, destroy };
}
