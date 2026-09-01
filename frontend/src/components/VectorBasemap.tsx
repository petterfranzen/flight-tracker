import { useCallback, useEffect, useRef } from "react";
import { useMap, useMapEvents } from "react-leaflet";
import L from "leaflet";
import { AIRPORTS, CITIES, COUNTRIES } from "../worldMapData";

// Leaflet's own default CRS — used directly (not map.options.crs, which
// is the same object here, but this makes the precompute step below
// independent of any single map instance) so the one-time projection
// pass below and the per-redraw pixel math stay exactly consistent with
// however Leaflet itself positions markers.
//
// .projection and .transformation are real, documented instance
// properties on every Leaflet CRS (see L.CRS.Earth's own source) —
// @types/leaflet just doesn't declare them, so the cast below is purely
// a typings gap, not an undocumented/private API being reached into.
const CRS = L.CRS.EPSG3857 as unknown as L.CRS & {
  projection: { project(latlng: L.LatLng): L.Point };
  transformation: { transform(point: L.Point, scale: number): L.Point };
};

// The expensive part of lat/lng -> pixel conversion is the spherical-
// Mercator projection itself (real trig per point). It's also the part
// that *never changes* — a point's projected "world" position is fixed
// regardless of pan or zoom; only the cheap affine scale+offset step
// (CRS.transformation.transform, then subtracting the map's current
// pixel origin) depends on the current view. Doing the expensive part
// once here, at module load, instead of inside redraw() is the actual
// fix for the reported lag: redraw() was calling Leaflet's
// latLngToLayerPoint (full projection, real trig) for every single
// point in the dataset — roughly 10,000+ calls per redraw (~180
// countries x up to ~200 ring points, plus ~600 cities, plus ~380
// airports) — on every moveend/zoomend, synchronously, before the
// canvas could repaint. Markers, which Leaflet positions natively and
// cheaply, would already be settled by the time that finished, which is
// exactly the "icons move first, then the map catches up" the user
// reported. Precomputing leaves only the cheap affine step per point at
// redraw time.
function projectWorld(lon: number, lat: number): L.Point {
  return CRS.projection.project(L.latLng(lat, lon));
}

interface WorldCountry {
  name: string;
  rings: L.Point[][];
  labelWorld: L.Point | null;
}
const WORLD_COUNTRIES: WorldCountry[] = COUNTRIES.map((c) => ({
  name: c.name,
  rings: c.rings.map((ring) => ring.map(([lon, lat]) => projectWorld(lon, lat))),
  labelWorld: c.label ? projectWorld(c.label[0], c.label[1]) : null,
}));

const WORLD_CITIES = CITIES.map((c) => ({ ...c, world: projectWorld(c.pos[0], c.pos[1]) }));
const WORLD_AIRPORTS = AIRPORTS.map((a) => ({ ...a, world: projectWorld(a.pos[0], a.pos[1]) }));

// Precomputed once at module load, not per redraw — cheap bbox rejection
// for ~180 countries is what keeps a full-canvas redraw affordable on
// every moveend/zoomend, since most countries are off-screen at any given
// view and don't need their (up to ~200-point) rings visited at all.
const COUNTRY_BOUNDS = COUNTRIES.map((c) => {
  let minLon = 180, maxLon = -180, minLat = 90, maxLat = -90;
  for (const ring of c.rings) {
    for (const [lon, lat] of ring) {
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
  }
  return { minLon, maxLon, minLat, maxLat };
});

function bboxIntersects(a: L.LatLngBounds, minLon: number, maxLon: number, minLat: number, maxLat: number) {
  return minLon <= a.getEast() && maxLon >= a.getWest() && minLat <= a.getNorth() && maxLat >= a.getSouth();
}

// How many extra view-widths of margin the canvas covers beyond the
// current viewport on every side — same reasoning as MapTint before it:
// this pane is a child of Leaflet's own pan-transformed _mapPane, so an
// active drag moves it for free via the shared CSS transform with zero
// per-frame JS; the canvas only needs *redrawing* (repainting its actual
// pixel content, not just repositioning) on moveend/zoomend/viewreset/
// resize, and the padding is what keeps real content visible right up to
// the edge of a normal drag gesture in between those redraws instead of
// running out into blank canvas.
const BASEMAP_PADDING_VIEWPORTS = 1;

const LAND_TOP = "#8a1a26";
const LAND_BOTTOM = "#4c0e17";
const LAND_OUTLINE = "#ff2d3d";
const BORDER_COLOR = "rgba(60, 224, 255, 0.4)";
const HOME_COUNTRY_COLOR = "#ffb63c";
const GRID_COLOR = "rgba(255, 45, 61, 0.06)";
const BG_COLOR = "#0a0305";
const CITY_DOT_COLOR = "#e2ddc9";
const CITY_LABEL_COLOR = "rgba(226, 221, 201, 0.85)";
const AIRPORT_COLOR = "#e2ddc9";
const COUNTRY_LABEL_COLOR = "rgba(125, 144, 163, 0.8)";

// The app's home country (see FlightMap.css's --color-marker-selected
// restraint comment) gets the same amber-outline treatment the earlier
// static mockup gave it — a real, meaningful highlight rather than an
// arbitrary accent color, kept even though this basemap now covers the
// whole world instead of one fixed regional crop.
const HOME_COUNTRY_NAME = "Sweden";

/**
 * Cyberpunk theme's map — real country outlines/borders/major cities/
 * major airports/country names drawn from real Natural Earth data (see
 * worldMapData.ts), replacing OpenStreetMap's raster tiles entirely for
 * this theme rather than tinting them.
 *
 * Why not the tinting approach tried first: it broke down in exactly the
 * ways the user reported — Leaflet's tile-loading placeholders (visible
 * any time a fresh area's tiles haven't finished fetching yet, e.g.
 * during the flyTo animation between selecting two different aircraft)
 * showed through the red tint as a flashing grid, since a CSS filter/
 * blend-mode over raster tiles has no way to distinguish "no tile here
 * yet" from "tinted tile" — and the colors were only ever an
 * approximation of real tile colors, never an exact match for the
 * reference. Drawing the map ourselves sidesteps both: there's no
 * network-dependent loading state to flash (every redraw draws whatever
 * data is already in memory, instantly), and every color is the actual
 * value, not a filter guess.
 *
 * Architecture follows the same pattern MapTint worked out for the
 * now-removed tint overlay: lives in its own Leaflet pane at tilePane's
 * usual z-index (200, so it's safely under markerPane's 600), and is a
 * *repaint*, not a reposition, on moveend/zoomend/viewreset/resize only
 * — never on plain 'move'/'zoom', which fire continuously during an
 * active gesture. Panning during that gesture is still smooth for free,
 * the same way it is for tiles: the pane is a child of Leaflet's own
 * pan-transformed _mapPane, so the *already-drawn* canvas content moves
 * via the shared CSS transform without this component doing anything.
 */
export default function VectorBasemap() {
  const map = useMap();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    // Same z-index as tilePane (200, set by Leaflet core regardless of
    // whether a TileLayer is mounted) — the always-present but blank
    // TileLayer (see BLANK_TILE_URL in FlightMap.tsx) mounts first, so
    // this pane's own DOM insertion happens after it and naturally
    // stacks on top at that equal z-index, safely under markerPane's 600.
    const pane = map.createPane("vectorBasemap");
    pane.style.zIndex = "200";
    pane.style.pointerEvents = "none";
    const canvas = document.createElement("canvas");
    pane.appendChild(canvas);
    canvasRef.current = canvas;
    return () => {
      canvas.remove();
      map.getPane("vectorBasemap")?.remove();
    };
  }, [map]);

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const size = map.getSize();
    const pad = BASEMAP_PADDING_VIEWPORTS;
    const topLeftContainer: [number, number] = [-size.x * pad, -size.y * pad];
    const bottomRightContainer: [number, number] = [size.x * (1 + pad), size.y * (1 + pad)];
    const topLeftLayer = map.containerPointToLayerPoint(topLeftContainer);
    const canvasW = size.x * (1 + 2 * pad);
    const canvasH = size.y * (1 + 2 * pad);

    const dpr = window.devicePixelRatio || 1;
    canvas.style.left = `${topLeftLayer.x}px`;
    canvas.style.top = `${topLeftLayer.y}px`;
    canvas.style.width = `${canvasW}px`;
    canvas.style.height = `${canvasH}px`;
    canvas.width = canvasW * dpr;
    canvas.height = canvasH * dpr;
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx.fillStyle = BG_COLOR;
    ctx.fillRect(0, 0, canvasW, canvasH);

    // View bounds for the padded canvas area (in real lon/lat), used to
    // cheaply reject off-screen countries/cities/airports before doing
    // any real projection or path work on them.
    const bounds = map
      .containerPointToLatLng(topLeftContainer as unknown as L.PointExpression)
      .toBounds(0)
      .extend(map.containerPointToLatLng(bottomRightContainer as unknown as L.PointExpression));

    // Slow path (real Leaflet projection, real trig) — kept only for the
    // lat/long grid lines, ~150 points total, not worth a fast path of
    // its own.
    function project(lon: number, lat: number): [number, number] {
      const p = map.latLngToLayerPoint([lat, lon]);
      return [p.x - topLeftLayer.x, p.y - topLeftLayer.y];
    }

    // Fast path for everything else (country rings, city/airport points,
    // label positions — the ~10,000+ calls per redraw that made this
    // slow): only the cheap affine step (CRS.transformation.transform,
    // then subtracting the current pixel origin) runs here, since the
    // real projection for every point was already done once at module
    // load (see WORLD_COUNTRIES/WORLD_CITIES/WORLD_AIRPORTS above).
    const zoom = map.getZoom();
    const scale = CRS.scale(zoom);
    const pixelOrigin = map.getPixelOrigin();
    function projectFast(wp: L.Point): [number, number] {
      const p = CRS.transformation.transform(wp, scale);
      return [p.x - pixelOrigin.x - topLeftLayer.x, p.y - pixelOrigin.y - topLeftLayer.y];
    }

    ctx.strokeStyle = GRID_COLOR;
    ctx.lineWidth = 1;
    const gridStepDeg = 10;
    for (let lon = -180; lon <= 180; lon += gridStepDeg) {
      if (lon < bounds.getWest() - gridStepDeg || lon > bounds.getEast() + gridStepDeg) continue;
      const a = project(lon, Math.max(-85, bounds.getSouth()));
      const b = project(lon, Math.min(85, bounds.getNorth()));
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
      ctx.stroke();
    }
    for (let lat = -80; lat <= 80; lat += gridStepDeg) {
      if (lat < bounds.getSouth() - gridStepDeg || lat > bounds.getNorth() + gridStepDeg) continue;
      const a = project(bounds.getWest(), lat);
      const b = project(bounds.getEast(), lat);
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
      ctx.stroke();
    }

    const gradient = ctx.createLinearGradient(0, 0, 0, canvasH);
    gradient.addColorStop(0, LAND_TOP);
    gradient.addColorStop(1, LAND_BOTTOM);

    function drawCountryRings(c: WorldCountry) {
      ctx.beginPath();
      for (const ring of c.rings) {
        ring.forEach((wp, i) => {
          const [x, y] = projectFast(wp);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.closePath();
      }
    }

    const visible: { c: WorldCountry; b: (typeof COUNTRY_BOUNDS)[number] }[] = [];
    WORLD_COUNTRIES.forEach((c, i) => {
      const b = COUNTRY_BOUNDS[i];
      if (bboxIntersects(bounds, b.minLon, b.maxLon, b.minLat, b.maxLat)) visible.push({ c, b });
    });

    ctx.fillStyle = gradient;
    visible.forEach(({ c }) => {
      drawCountryRings(c);
      ctx.fill();
    });
    ctx.strokeStyle = LAND_OUTLINE;
    ctx.lineWidth = 1.1;
    visible.forEach(({ c }) => {
      drawCountryRings(c);
      ctx.stroke();
    });
    ctx.strokeStyle = BORDER_COLOR;
    ctx.lineWidth = 0.7;
    visible.forEach(({ c }) => {
      if (c.name === HOME_COUNTRY_NAME) return;
      drawCountryRings(c);
      ctx.stroke();
    });
    const home = visible.find(({ c }) => c.name === HOME_COUNTRY_NAME);
    if (home) {
      ctx.strokeStyle = HOME_COUNTRY_COLOR;
      ctx.lineWidth = 1.8;
      ctx.shadowColor = "rgba(255, 182, 60, 0.5)";
      ctx.shadowBlur = 4;
      drawCountryRings(home.c);
      ctx.stroke();
      ctx.shadowBlur = 0;
    }

    // Country name labels — skipped below a minimum on-screen ring span,
    // not a fixed zoom threshold: a tiny country stays unlabeled at a
    // zoom where it'd only be a few px wide regardless of zoom level
    // number, while a huge one earns its label even zoomed out.
    ctx.font = "600 11px 'Rajdhani', system-ui, sans-serif";
    ctx.fillStyle = COUNTRY_LABEL_COLOR;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    visible.forEach(({ c, b }) => {
      if (!c.labelWorld) return;
      // Bbox corners: a per-visible-country calculation (at most a few
      // dozen), not per ring point, so the slow/real-projection path is
      // fine here — no need for a fast-path variant just for this.
      const topLeftPx = project(b.minLon, b.maxLat);
      const bottomRightPx = project(b.maxLon, b.minLat);
      const wPx = Math.abs(bottomRightPx[0] - topLeftPx[0]);
      const hPx = Math.abs(bottomRightPx[1] - topLeftPx[1]);
      if (wPx < 60 || hPx < 40) return;
      const [x, y] = projectFast(c.labelWorld);
      ctx.fillText(c.name.toUpperCase(), x, y);
    });

    // Cities — small dot + label, distinct from airport markers below.
    ctx.font = "500 10px 'JetBrains Mono', monospace";
    WORLD_CITIES.forEach((city) => {
      if (!bounds.contains([city.pos[1], city.pos[0]])) return;
      const [x, y] = projectFast(city.world);
      ctx.beginPath();
      ctx.arc(x, y, city.capital ? 2.4 : 1.6, 0, Math.PI * 2);
      ctx.fillStyle = CITY_DOT_COLOR;
      ctx.fill();
      ctx.fillStyle = CITY_LABEL_COLOR;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(city.name, x + 5, y);
    });

    // Airports — square outline mark + IATA code, matching the earlier
    // approved mockup's own airport-vs-aircraft visual distinction.
    ctx.font = "600 10px 'JetBrains Mono', monospace";
    WORLD_AIRPORTS.forEach((ap) => {
      if (!bounds.contains([ap.pos[1], ap.pos[0]])) return;
      const [x, y] = projectFast(ap.world);
      ctx.strokeStyle = AIRPORT_COLOR;
      ctx.lineWidth = 1.3;
      ctx.strokeRect(x - 3, y - 3, 6, 6);
      ctx.fillStyle = CITY_LABEL_COLOR;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(ap.code, x + 6, y);
    });
  }, [map]);

  useEffect(() => {
    redraw();
  }, [redraw]);

  useMapEvents({
    moveend: redraw,
    zoomend: redraw,
    resize: redraw,
  });

  return null;
}
