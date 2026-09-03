import { useCallback, useEffect, useRef } from "react";
import { useMap, useMapEvents } from "react-leaflet";
import L from "leaflet";
import { AIRPORTS, CITIES, COUNTRIES, LAKES, RIVERS } from "../worldMapData";
import { fetchAirportGates, type AirportGateFeature } from "../api/flightApi";

// Leaflet's own default CRS — used directly (not map.options.crs, which
// is the same object here, but this makes the precompute step below,
// and paintBuffer()'s per-zoom-level rendering below, independent of any
// single map instance) so all of this stays exactly consistent with
// however Leaflet itself positions markers.
//
// .projection and .transformation are real, documented instance
// properties on every Leaflet CRS (see L.CRS.Earth's own source) —
// @types/leaflet just doesn't declare them, so the cast below is purely
// a typings gap, not an undocumented/private API being reached into.
// unproject/untransform are each their project/transform's real inverse,
// used below to turn a rendered buffer's pixel rectangle back into the
// lat/lng bounds needed for visibility culling, without touching a live
// map's current view.
const CRS = L.CRS.EPSG3857 as unknown as L.CRS & {
  projection: { project(latlng: L.LatLng): L.Point; unproject(point: L.Point): L.LatLng };
  transformation: { transform(point: L.Point, scale: number): L.Point; untransform(point: L.Point, scale: number): L.Point };
};

// The expensive part of lat/lng -> pixel conversion is the spherical-
// Mercator projection itself (real trig per point). It's also the part
// that *never changes* — a point's projected "world" position is fixed
// regardless of pan or zoom; only the cheap affine scale+offset step
// (CRS.transformation.transform, then subtracting the buffer's own
// top-left) depends on the zoom level being painted. Doing the expensive
// part once here, at module load, instead of inside paintBuffer() is the
// actual fix for the originally reported lag: redraw() used to call
// Leaflet's latLngToLayerPoint (full projection, real trig) for every
// single point in the dataset — roughly 10,000+ calls per redraw (~180
// countries x up to ~200 ring points, plus ~600 cities, plus ~380
// airports) — on every moveend/zoomend, synchronously, before the canvas
// could repaint. Precomputing leaves only the cheap affine step per
// point at paint time.
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

const WORLD_CITIES = CITIES.map((c) => ({
  ...c,
  world: projectWorld(c.pos[0], c.pos[1]),
  worldOutline: c.outline ? c.outline.map(([lon, lat]) => projectWorld(lon, lat)) : null,
}));
const WORLD_AIRPORTS = AIRPORTS.map((a) => ({
  ...a,
  world: projectWorld(a.pos[0], a.pos[1]),
  worldRunways: a.runways ? a.runways.map((seg) => seg.map(([lon, lat]) => projectWorld(lon, lat))) : null,
}));

// Precomputed once at module load, not per paint — cheap bbox rejection
// for ~180 countries is what keeps a full-canvas paint affordable, since
// most countries are off-screen at any given view and don't need their
// (up to ~200-point) rings visited at all.
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

// Same idea as WORLD_COUNTRIES/COUNTRY_BOUNDS above, for the two water-
// feature layers: real topography (rivers, lakes) Natural Earth's admin-0
// country polygons never carried at all — added per feedback that the
// basemap read as bare political outlines with nothing else geographic
// on it. Bounds-of-a-single-ring/path, not per-ring like COUNTRY_BOUNDS,
// since each river/lake feature here already is one path/ring (see
// scripts/generate_world_map_data.py — a lake keeps only its outer ring,
// a river MultiLineString is split into one RiverFeature per part).
function boundsOfPoints(pts: readonly (readonly [number, number])[]) {
  let minLon = 180, maxLon = -180, minLat = 90, maxLat = -90;
  for (const [lon, lat] of pts) {
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  return { minLon, maxLon, minLat, maxLat };
}
const WORLD_RIVERS = RIVERS.map((r) => r.path.map(([lon, lat]) => projectWorld(lon, lat)));
const RIVER_BOUNDS = RIVERS.map((r) => boundsOfPoints(r.path));
const WORLD_LAKES = LAKES.map((lk) => lk.ring.map(([lon, lat]) => projectWorld(lon, lat)));
const LAKE_BOUNDS = LAKES.map((lk) => boundsOfPoints(lk.ring));

function bboxIntersects(a: L.LatLngBounds, minLon: number, maxLon: number, minLat: number, maxLat: number) {
  return minLon <= a.getEast() && maxLon >= a.getWest() && minLat <= a.getNorth() && maxLat >= a.getSouth();
}

// How many extra view-widths of margin each buffer covers beyond the
// viewport on every side. A child of Leaflet's own pan-transformed
// _mapPane moves for free via the shared CSS transform with zero
// per-frame JS, so this is purely "how far can you pan before running
// past the edge of what's already painted, showing raw background where
// the PAN_REFRESH_THROTTLE_MS-throttled repaint hasn't caught up yet" —
// bigger means fewer/rarer flashes like that during a long or fast drag,
// at the cost of a bigger backing-store bitmap per cached buffer (see
// ZOOM_CACHE_MAX_LEVELS below for the other side of that memory trade-off).
// Raised from 0.3->0.5->1 across two rounds of live testing once actual
// memory headroom confirmed there was room for it.
const BASEMAP_PADDING_VIEWPORTS = 1;

// devicePixelRatio can be 3+ on some phones; combined with the padding
// above that would still balloon the backing store for a sharpness
// improvement no one can see at map-basemap detail levels, so it's
// capped.
const MAX_DPR = 2;

// Safety cap on how many zoom levels the cache below will ever try to
// hold at once. In practice the app's real zoom range (minZoom=2 in
// FlightMap.tsx, maxZoom=18 from the always-mounted TileLayer's own
// default) is 17 levels — comfortably under this — so every real level
// ends up cached; this only guards against map.getMaxZoom() coming back
// Infinity (no layer sets one) and the fill loop below trying to walk an
// unbounded range.
const ZOOM_CACHE_MAX_LEVELS = 24;

// How often a live drag's background buffer gets refreshed while it's
// still in progress. Leaflet's 'move' event fires continuously (up to
// every frame) during a drag; repainting on every single one would be
// exactly the "redraw on continuous move/zoom" cost the original
// performance review flagged. Throttling to this interval means the
// buffer keeps extending in whatever direction the drag has actually
// gone roughly every 150ms while it continues — long before the buffer
// margin above would otherwise run out — without repainting on every frame.
const PAN_REFRESH_THROTTLE_MS = 150;

const LAND_TOP = "#8a1a26";
const LAND_BOTTOM = "#4c0e17";
const LAND_OUTLINE = "#ff2d3d";
const BORDER_COLOR = "rgba(60, 224, 255, 0.4)";
const HOME_COUNTRY_COLOR = "#ffb63c";
// Only ever visible over ocean/unfilled canvas: drawn before the opaque
// country fill below, which paints over it everywhere there's land —
// raising the opacity here doesn't need a separate "skip over land"
// check, the draw order already guarantees that.
const GRID_COLOR = "rgba(255, 45, 61, 0.16)";
const BG_COLOR = "#0a0305";
// Same cyan family as BORDER_COLOR/the accent tick elsewhere in this
// theme, not a "realistic" map blue — reads as water against the red
// land fill without introducing a whole new hue the rest of the palette
// doesn't otherwise use.
const LAKE_FILL_COLOR = "#0d2a33";
const LAKE_OUTLINE_COLOR = "rgba(60, 224, 255, 0.5)";
const RIVER_COLOR = "rgba(60, 224, 255, 0.4)";
const CITY_DOT_COLOR = "#e2ddc9";
const CITY_LABEL_COLOR = "rgba(226, 221, 201, 0.85)";
const AIRPORT_COLOR = "#e2ddc9";
const COUNTRY_LABEL_COLOR = "rgba(125, 144, 163, 0.8)";
const URBAN_FILL_COLOR = "rgba(226, 221, 201, 0.08)";
const URBAN_OUTLINE_COLOR = "rgba(226, 221, 201, 0.35)";
const RUNWAY_COLOR = "rgba(226, 221, 201, 0.55)";
// Below this on-screen size, a city/airport's outline geometry is drawn
// as one blob of edges no bigger than the dot/mark that already stands
// for it — the whole point of drawing it is to show real shape once
// there's room, so a redundant illegible smear isn't worth the paint
// cost. Falls back to the existing dot/square, same as before either
// data field existed.
const MIN_OUTLINE_PX = 8;

// Terminal/hangar buildings and parking aprons (filled polygons), and
// individual gate positions (points) — real OpenStreetMap infrastructure
// via the backend's Overpass proxy (see fetchAirportGates), not bundled
// data like the country/city/runway geometry above: no dataset at that
// scale has this, it only exists per-airport. Only fetched (see
// scheduleGateFetch below) and drawn once zoomed in this close.
// Originally 14 (needing to zoom in past individual-street scale before
// any of this showed at all, per live user feedback); 12 still keeps
// this well clear of GATES_MIN_ZOOM's own reason to exist (invisible at
// anything wider than a single airport's footprint) while surfacing the
// terminal/apron shapes - the parts big enough to read as real geometry
// even before you're zoomed in enough to make out individual gate dots -
// noticeably sooner.
const GATES_MIN_ZOOM = 12;

// How close (on-screen px) a click needs to land to an airport's dot to
// count as "clicked that airport" — generous enough for a real tap/click on
// a ~3px-radius dot plus its label without stealing clicks meant for
// something else further away. Only checked below GATES_MIN_ZOOM: past
// that the real outline is already on screen as the guide, so there's
// nothing left for a click here to do.
const AIRPORT_CLICK_RADIUS_PX = 20;

// How far (px) a mousedown->click pair can drift and still count as a
// real click rather than a pan that happened to end near an airport —
// see the mousedown/click handlers below. Comfortably past a shaky-hand
// stationary click, well short of a real drag.
const CLICK_DRAG_TOLERANCE_PX = 6;

// Where a clicked airport's own zoom-to lands when no real gate/apron/
// terminal geometry is available to fit bounds to (fetch still in flight,
// failed, or OSM genuinely has none for this airport) — comfortably past
// GATES_MIN_ZOOM so at least the runway centerlines this basemap can
// already draw become visible, rather than landing exactly on the
// threshold and showing nothing new.
const AIRPORT_ZOOM_TO_FALLBACK_ZOOM = GATES_MIN_ZOOM + 3;

const APRON_FILL_COLOR = "rgba(125, 144, 163, 0.10)";
const APRON_OUTLINE_COLOR = "rgba(125, 144, 163, 0.4)";
const TERMINAL_FILL_COLOR = "rgba(226, 221, 201, 0.14)";
const TERMINAL_OUTLINE_COLOR = "rgba(226, 221, 201, 0.6)";
const GATE_COLOR = "#e2ddc9";

// Bumped from 11/10/13px and a 6px airport dot (real feedback: labels and
// marks read as "too small" once there was more of everything else on
// screen to compete with — see CITY_MIN_POP/AIRPORT_TYPES in
// generate_world_map_data.py for the "more information" half of that).
const COUNTRY_FONT = "600 13px 'Rajdhani', system-ui, sans-serif";
const CITY_FONT = "500 11px 'JetBrains Mono', monospace";
// Bumped from 10px/radius-3 (real user feedback: "cannot see it") — this
// mark is the only thing showing where an airport is below GATES_MIN_ZOOM,
// and it's also the click target the airport click-to-zoom handler hit-
// tests against (see AIRPORT_CLICK_RADIUS_PX, sized to comfortably exceed
// this radius).
const AIRPORT_FONT = "700 14px 'JetBrains Mono', monospace";
const AIRPORT_DOT_RADIUS = 7;

// The app's home country (see FlightMap.css's --color-marker-selected
// restraint comment) gets the same amber-outline treatment the earlier
// static mockup gave it — a real, meaningful highlight rather than an
// arbitrary accent color, kept even though this basemap now covers the
// whole world instead of one fixed regional crop.
const HOME_COUNTRY_NAME = "Sweden";

/** One pre-rendered, padded-viewport bitmap for a single zoom level. */
interface ZoomBuffer {
  canvas: HTMLCanvasElement;
  zoom: number;
  /** Absolute world-pixel (at this buffer's own zoom scale) of the canvas's top-left corner — independent of any live map view, used to reposition this buffer against whatever the current view is later. */
  topLeftWorldPx: L.Point;
  canvasW: number;
  canvasH: number;
}

/**
 * Paints one zoom level's content into `canvas`, centered on `center`,
 * covering `size` (the map container's CSS pixel size) plus padding.
 * Pure with respect to any live Leaflet map instance — everything here
 * is real CRS math against an arbitrary (center, zoom), which is what
 * lets this run for zoom levels the map isn't even currently at, ahead
 * of time, for the pre-rendered cache below. Also pure with respect to
 * `gateCache` — a read-only snapshot, keyed by airport code, of whatever
 * Overpass gate data has arrived so far (see scheduleGateFetch); this
 * function never fetches, it only draws whatever's already there.
 */
function paintBuffer(canvas: HTMLCanvasElement, center: L.LatLng, zoom: number, size: L.Point, gateCache: Map<string, AirportGateFeature[]>): ZoomBuffer {
  const pad = BASEMAP_PADDING_VIEWPORTS;
  const canvasW = size.x * (1 + 2 * pad);
  const canvasH = size.y * (1 + 2 * pad);
  const scale = CRS.scale(zoom);
  const centerWorldPx = CRS.transformation.transform(CRS.projection.project(center), scale);
  const topLeftWorldPx = centerWorldPx.subtract(L.point(canvasW / 2, canvasH / 2));

  const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
  const targetW = Math.round(canvasW * dpr);
  const targetH = Math.round(canvasH * dpr);
  // Only touch canvas.width/height — which clears the canvas and makes
  // the browser/GPU discard and reallocate the whole backing texture —
  // when the pixel dimensions actually need to change. A buffer refresh
  // at an unchanged container size reuses the existing backing store.
  if (canvas.width !== targetW || canvas.height !== targetH) {
    canvas.width = targetW;
    canvas.height = targetH;
  }
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  ctx.fillStyle = BG_COLOR;
  ctx.fillRect(0, 0, canvasW, canvasH);

  function latLngFromWorldPx(wp: L.Point): L.LatLng {
    return CRS.projection.unproject(CRS.transformation.untransform(wp, scale));
  }
  // View bounds for the padded buffer area (in real lon/lat), used to
  // cheaply reject off-screen countries/cities/airports before doing any
  // real path work on them.
  const bounds = L.latLngBounds(
    latLngFromWorldPx(topLeftWorldPx),
    latLngFromWorldPx(topLeftWorldPx.add(L.point(canvasW, canvasH))),
  );

  // Only the cheap affine step (CRS.transformation.transform, then
  // subtracting this buffer's own top-left) runs per point here, since
  // the real projection for every point in the dataset was already done
  // once at module load (see WORLD_COUNTRIES/WORLD_CITIES/WORLD_AIRPORTS
  // above). Used for everything: country rings, city/airport points,
  // label positions, and (via projectWorld) the lat/long grid lines too
  // — those aren't in a precomputed array, but projectWorld is cheap
  // enough for the ~150 grid points involved that a separate "slow path"
  // isn't worth it once nothing here needs a live map's own
  // latLngToLayerPoint anymore.
  function projectFast(wp: L.Point): [number, number] {
    const p = CRS.transformation.transform(wp, scale);
    return [p.x - topLeftWorldPx.x, p.y - topLeftWorldPx.y];
  }
  function project(lon: number, lat: number): [number, number] {
    return projectFast(projectWorld(lon, lat));
  }

  ctx.strokeStyle = GRID_COLOR;
  ctx.lineWidth = 1;
  // Halved again, from 5 (itself already halved from an original 10) —
  // each halving quarters a cell's area, i.e. fits 4 of the new squares
  // inside one of the old ones (equivalently: split each cell in half
  // vertically, then split each of those halves into 4 equal squares).
  const gridStepDeg = 2.5;
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

  function countryPath(c: WorldCountry): Path2D {
    const path = new Path2D();
    for (const ring of c.rings) {
      ring.forEach((wp, i) => {
        const [x, y] = projectFast(wp);
        if (i === 0) path.moveTo(x, y);
        else path.lineTo(x, y);
      });
      path.closePath();
    }
    return path;
  }

  const visible: { c: WorldCountry; b: (typeof COUNTRY_BOUNDS)[number] }[] = [];
  WORLD_COUNTRIES.forEach((c, i) => {
    const b = COUNTRY_BOUNDS[i];
    if (bboxIntersects(bounds, b.minLon, b.maxLon, b.minLat, b.maxLat)) visible.push({ c, b });
  });

  // Every visible country's ring points get projected exactly once here
  // (not once per draw pass) and folded into 3 combined Path2Ds, so the
  // whole basemap fills/strokes in 3 canvas draw calls total instead of
  // ~3 per visible country — canvas 2D backends can batch a single
  // fill()/stroke() far better than hundreds of tiny separate ones.
  const fillPath = new Path2D();
  const outlinePath = new Path2D();
  const borderPath = new Path2D();
  let homePath: Path2D | null = null;
  visible.forEach(({ c }) => {
    const path = countryPath(c);
    fillPath.addPath(path);
    outlinePath.addPath(path);
    if (c.name === HOME_COUNTRY_NAME) homePath = path;
    else borderPath.addPath(path);
  });

  ctx.fillStyle = gradient;
  ctx.fill(fillPath);
  ctx.strokeStyle = LAND_OUTLINE;
  ctx.lineWidth = 1.1;
  ctx.stroke(outlinePath);
  ctx.strokeStyle = BORDER_COLOR;
  ctx.lineWidth = 0.7;
  ctx.stroke(borderPath);
  if (homePath) {
    // A wide, translucent stroke underneath a solid one stands in for
    // the glow ctx.shadowBlur used to give — canvas shadows force an
    // unaccelerated software rasterization pass for any blur radius on
    // a multi-vertex path, where two plain strokes render at normal
    // (GPU-accelerated) canvas stroke cost.
    ctx.strokeStyle = "rgba(255, 182, 60, 0.25)";
    ctx.lineWidth = 4;
    ctx.stroke(homePath);
    ctx.strokeStyle = HOME_COUNTRY_COLOR;
    ctx.lineWidth = 1.8;
    ctx.stroke(homePath);
  }

  // Real topography — lakes (filled) and river centerlines (stroked),
  // both drawn on top of the land fill/outline above (they're geographic
  // features *within* land, not part of its boundary) but under the
  // city/airport marks and labels below. Same bbox-precheck-then-one-
  // combined-Path2D approach as the country fill above, for the same
  // reason: cheap rejection of the (large majority, at any real zoom)
  // off-screen features before touching their point data at all.
  const lakeFillPath = new Path2D();
  const lakeOutlinePath = new Path2D();
  LAKES.forEach((_, i) => {
    const b = LAKE_BOUNDS[i];
    if (!bboxIntersects(bounds, b.minLon, b.maxLon, b.minLat, b.maxLat)) return;
    const path = new Path2D();
    WORLD_LAKES[i].forEach((wp, j) => {
      const [x, y] = projectFast(wp);
      if (j === 0) path.moveTo(x, y);
      else path.lineTo(x, y);
    });
    path.closePath();
    lakeFillPath.addPath(path);
    lakeOutlinePath.addPath(path);
  });
  ctx.fillStyle = LAKE_FILL_COLOR;
  ctx.fill(lakeFillPath);
  ctx.strokeStyle = LAKE_OUTLINE_COLOR;
  ctx.lineWidth = 0.8;
  ctx.stroke(lakeOutlinePath);

  const riverPath = new Path2D();
  RIVERS.forEach((_, i) => {
    const b = RIVER_BOUNDS[i];
    if (!bboxIntersects(bounds, b.minLon, b.maxLon, b.minLat, b.maxLat)) return;
    WORLD_RIVERS[i].forEach((wp, j) => {
      const [x, y] = projectFast(wp);
      if (j === 0) riverPath.moveTo(x, y);
      else riverPath.lineTo(x, y);
    });
  });
  ctx.strokeStyle = RIVER_COLOR;
  ctx.lineWidth = 1;
  ctx.stroke(riverPath);

  // City urban-area outlines — a subtle filled/stroked shape under the
  // dot+label (drawn below in the label pass), only once there's enough
  // on-screen room for a real shape to read as more than a smear
  // (MIN_OUTLINE_PX); falls back to the plain dot otherwise, the same
  // way a country stays unlabeled below its own size threshold.
  WORLD_CITIES.forEach((city) => {
    if (!city.worldOutline || !bounds.contains([city.pos[1], city.pos[0]])) return;
    const path = new Path2D();
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    city.worldOutline.forEach((wp, i) => {
      const [x, y] = projectFast(wp);
      if (i === 0) path.moveTo(x, y);
      else path.lineTo(x, y);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    });
    path.closePath();
    if (Math.max(maxX - minX, maxY - minY) < MIN_OUTLINE_PX) return;
    ctx.fillStyle = URBAN_FILL_COLOR;
    ctx.fill(path);
    ctx.strokeStyle = URBAN_OUTLINE_COLOR;
    ctx.lineWidth = 1;
    ctx.stroke(path);
  });

  // Airport runways — real centerlines (see worldMapData.ts's header for
  // where this comes from), same MIN_OUTLINE_PX-gated fallback to the
  // plain square mark drawn below in the label pass.
  WORLD_AIRPORTS.forEach((ap) => {
    if (!ap.worldRunways || !bounds.contains([ap.pos[1], ap.pos[0]])) return;
    const segs = ap.worldRunways.map((seg) => seg.map((wp) => projectFast(wp)));
    const longest = Math.max(...segs.map(([[x1, y1], [x2, y2]]) => Math.hypot(x2 - x1, y2 - y1)));
    if (longest < MIN_OUTLINE_PX) return;
    ctx.strokeStyle = RUNWAY_COLOR;
    ctx.lineWidth = 2;
    segs.forEach(([[x1, y1], [x2, y2]]) => {
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    });
  });

  // Real terminal/apron/hangar/gate geometry (see GATES_MIN_ZOOM's own
  // comment) — drawn straight from gateCache, whatever's arrived so far;
  // scheduleGateFetch is what actually populates it and triggers a
  // repaint once a fetch lands, this only ever reads. Raw lon/lat pairs
  // from the API, not part of the module-load precompute (WORLD_CITIES
  // etc.) the way bundled data is — projected fresh here via
  // projectWorld, cheap enough at the point counts a single airport's
  // infrastructure actually has.
  if (zoom >= GATES_MIN_ZOOM) {
    for (const [, features] of gateCache) {
      for (const feature of features) {
        if (feature.kind === "gate") {
          const [lon, lat] = feature.ring[0];
          if (!bounds.contains([lat, lon])) continue;
          const [x, y] = projectFast(projectWorld(lon, lat));
          ctx.beginPath();
          ctx.arc(x, y, 1.8, 0, Math.PI * 2);
          ctx.fillStyle = GATE_COLOR;
          ctx.fill();
          continue;
        }
        // Cheap reject on the ring's first point before doing real path
        // work — good enough here (unlike countries, a single airport's
        // buildings/aprons are all clustered in one small area, so "is
        // any part of this feature's own airport in view" already
        // answered by the outer bounds check most of this loop is
        // filtered by in practice).
        const [lon0, lat0] = feature.ring[0];
        if (!bounds.contains([lat0, lon0])) continue;
        const path = new Path2D();
        feature.ring.forEach(([lon, lat], i) => {
          const [x, y] = projectFast(projectWorld(lon, lat));
          if (i === 0) path.moveTo(x, y);
          else path.lineTo(x, y);
        });
        path.closePath();
        if (feature.kind === "apron") {
          ctx.fillStyle = APRON_FILL_COLOR;
          ctx.fill(path);
          ctx.strokeStyle = APRON_OUTLINE_COLOR;
          ctx.lineWidth = 1;
          ctx.stroke(path);
        } else {
          // terminal and hangar share a look — both are buildings, the
          // distinction matters for what they *are* more than how a
          // basemap at this scale should render them differently.
          ctx.fillStyle = TERMINAL_FILL_COLOR;
          ctx.fill(path);
          ctx.strokeStyle = TERMINAL_OUTLINE_COLOR;
          ctx.lineWidth = 1.2;
          ctx.stroke(path);
        }
      }
    }
  }

  // Country/city/airport labels all compete for the same screen space at
  // low zoom (a few hundred cities+airports can land within a few dozen
  // px of each other), so instead of drawing each group independently —
  // which is what produced the original overlapping-text bug — every
  // label is a candidate box in one shared priority queue. Candidates
  // are sorted highest-priority first (countries > cities-by-population
  // > airports, capitals ahead of same-tier cities) and placed greedily,
  // skipping — dropping entirely, dot/mark included — any whose box
  // collides with one already placed. A smaller/lower-priority city
  // simply never gets a chance to draw once the space it needed is
  // taken, rather than drawing anyway and overlapping.
  interface LabelCandidate {
    priority: number;
    x0: number; y0: number; x1: number; y1: number;
    draw: () => void;
  }
  const LABEL_PAD = 2;
  const candidates: LabelCandidate[] = [];

  // Country labels — skipped below a minimum on-screen ring span, not a
  // fixed zoom threshold: a tiny country stays unlabeled at a zoom where
  // it'd only be a few px wide regardless of zoom level number, while a
  // huge one earns its label even zoomed out. Highest priority tier
  // (place-name hierarchy: country > city > airport), tie-broken by
  // on-screen size so bigger countries' names win any rare clash between
  // two country labels.
  ctx.font = COUNTRY_FONT;
  visible.forEach(({ c, b }) => {
    if (!c.labelWorld) return;
    const topLeftPx = project(b.minLon, b.maxLat);
    const bottomRightPx = project(b.maxLon, b.minLat);
    const wPx = Math.abs(bottomRightPx[0] - topLeftPx[0]);
    const hPx = Math.abs(bottomRightPx[1] - topLeftPx[1]);
    if (wPx < 60 || hPx < 40) return;
    const [x, y] = projectFast(c.labelWorld);
    const text = c.name.toUpperCase();
    const tw = ctx.measureText(text).width;
    const th = 13;
    candidates.push({
      priority: 3_000_000_000 + wPx * hPx,
      x0: x - tw / 2 - LABEL_PAD, y0: y - th / 2 - LABEL_PAD, x1: x + tw / 2 + LABEL_PAD, y1: y + th / 2 + LABEL_PAD,
      draw: () => {
        ctx.font = COUNTRY_FONT;
        ctx.fillStyle = COUNTRY_LABEL_COLOR;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(text, x, y);
      },
    });
  });

  // Cities — small dot + label, distinct from airport markers below.
  // Priority tier below countries, ordered within itself by capital
  // status then population — "drop smaller cities first" falls straight
  // out of that ordering combined with the greedy placement above.
  ctx.font = CITY_FONT;
  WORLD_CITIES.forEach((city) => {
    if (!bounds.contains([city.pos[1], city.pos[0]])) return;
    const [x, y] = projectFast(city.world);
    const r = city.capital ? 3.2 : 2.2;
    const tw = ctx.measureText(city.name).width;
    const th = 11;
    candidates.push({
      priority: 2_000_000_000 + (city.capital ? 100_000_000 : 0) + city.pop,
      x0: x - r, y0: y - th / 2 - LABEL_PAD, x1: x + 5 + tw + LABEL_PAD, y1: y + th / 2 + LABEL_PAD,
      draw: () => {
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fillStyle = CITY_DOT_COLOR;
        ctx.fill();
        ctx.font = CITY_FONT;
        ctx.fillStyle = CITY_LABEL_COLOR;
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillText(city.name, x + 5, y);
      },
    });
  });

  // Airports — a small dark-filled circle mark + IATA code, matching the
  // earlier approved mockup's own .airport-dot exactly (a void-filled
  // circle with a pale border, not a square — squares are Legend's
  // "tracked/selected" shape there). Lowest priority tier (no
  // size/importance data to rank them by, so plain dataset order breaks
  // ties) — a crowded area's airports are the first to be dropped, after
  // smaller cities, before any city or country name.
  //
  // TODO(known limitation): this shares a canvas/pane (z-index 200) with
  // land/cities/grid, which sits *under* markerPane (z-index 600) — a
  // plane or cluster mark can end up drawn on top of an airport's dot or
  // label. Fixing that for real means moving airport marks to their own
  // always-on-top pane, which is real new surface area (a second canvas,
  // its own redraw loop, losing this shared declutter queue) — started
  // and reverted here rather than shipped half-finished under time
  // pressure; airports disappearing entirely would be a worse regression
  // than the current "sometimes covered" issue.
  ctx.font = AIRPORT_FONT;
  WORLD_AIRPORTS.forEach((ap, i) => {
    if (!bounds.contains([ap.pos[1], ap.pos[0]])) return;
    const [x, y] = projectFast(ap.world);
    const tw = ctx.measureText(ap.code).width;
    const th = 14;
    const labelGap = AIRPORT_DOT_RADIUS + 3;
    candidates.push({
      priority: 1_000_000_000 - i,
      x0: x - AIRPORT_DOT_RADIUS, y0: y - th / 2 - LABEL_PAD, x1: x + labelGap + tw + LABEL_PAD, y1: y + th / 2 + LABEL_PAD,
      draw: () => {
        ctx.beginPath();
        ctx.arc(x, y, AIRPORT_DOT_RADIUS, 0, Math.PI * 2);
        ctx.fillStyle = BG_COLOR;
        ctx.fill();
        ctx.strokeStyle = AIRPORT_COLOR;
        ctx.lineWidth = 2.5;
        ctx.stroke();
        ctx.font = AIRPORT_FONT;
        ctx.fillStyle = CITY_LABEL_COLOR;
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillText(ap.code, x + labelGap, y);
      },
    });
  });

  candidates.sort((a, b) => b.priority - a.priority);
  const placed: { x0: number; y0: number; x1: number; y1: number }[] = [];
  for (const cand of candidates) {
    const collides = placed.some((p) => cand.x0 < p.x1 && cand.x1 > p.x0 && cand.y0 < p.y1 && cand.y1 > p.y0);
    if (collides) continue;
    cand.draw();
    placed.push(cand);
  }

  return { canvas, zoom, topLeftWorldPx, canvasW, canvasH };
}

type IdleHandle = number;
function scheduleIdle(fn: () => void): IdleHandle {
  const ric = (window as typeof window & { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }).requestIdleCallback;
  if (typeof ric === "function") return ric(fn, { timeout: 500 });
  return window.setTimeout(fn, 200);
}
function cancelIdle(handle: IdleHandle | null) {
  if (handle == null) return;
  const cic = (window as typeof window & { cancelIdleCallback?: (handle: number) => void }).cancelIdleCallback;
  if (typeof cic === "function") cic(handle);
  else clearTimeout(handle);
}

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
 * network-dependent loading state to flash, and every color is the
 * actual value, not a filter guess.
 *
 * Content lives across a pre-rendered cache (see ZoomBuffer/paintBuffer
 * above), one padded-viewport bitmap per zoom level in the app's whole
 * real zoom range (~17 levels — see ZOOM_CACHE_MAX_LEVELS), kept in its
 * own Leaflet pane at tilePane's usual z-index (200, safely under
 * markerPane's 600):
 *   - Zooming swaps in the target level's buffer at zoomstart (already
 *     known then, before the animation even plays) — a free swap, no
 *     drawing at all, since every level in range gets background-filled
 *     once and kept forever (a confirmed-affordable memory trade for
 *     every zoom, not just the immediate neighbor, being instant).
 *   - Panning keeps refreshing the current level's buffer, recentered on
 *     the live drag position, every PAN_REFRESH_THROTTLE_MS while the
 *     drag continues, plus a final refresh at rest — so the buffer keeps
 *     extending in whatever direction the drag actually goes instead of
 *     only catching up once it stops.
 *   - Whichever buffer is "current" is a real child of Leaflet's own
 *     pan-transformed _mapPane, so between refreshes it moves for free
 *     via the shared CSS transform, the same way tiles do.
 */
export interface AirportSelection {
  code: string;
  name: string;
  lat: number;
  lon: number;
}

export default function VectorBasemap({ onAirportSelect }: { onAirportSelect?: (ap: AirportSelection) => void }) {
  const map = useMap();
  const paneRef = useRef<HTMLElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const cacheRef = useRef<Map<number, ZoomBuffer>>(new Map());
  const panThrottleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fillHandleRef = useRef<IdleHandle | null>(null);
  // Keyed by airport code — see GATES_MIN_ZOOM/scheduleGateFetch below.
  // Grows for the lifetime of this component; never evicted, same
  // reasoning as the zoom-level cache above (bounded in practice by how
  // many distinct airports someone actually zooms in on in one session).
  const gateCacheRef = useRef<Map<string, AirportGateFeature[]>>(new Map());
  const gateFetchingRef = useRef<Set<string>>(new Set());
  // Set by smoothZoomTo below, read by the zoomstart handler further
  // down: while true, zoomstart skips its usual immediate buffer swap so
  // whichever buffer is already showing keeps riding Leaflet's own CSS
  // zoom-transition transform for the length of the animation (exactly
  // like it already does for a plain pan — see this file's own header on
  // buffers being real children of the pan-transformed pane) instead of
  // being replaced by the *target* buffer before that transform has even
  // started, which is what raced-past/vanished under the old animate:
  // false-only approach (see smoothZoomTo's own comment for the full
  // reasoning). zoomend always swaps regardless of this flag, landing on
  // the correct crisp buffer the instant the transition finishes.
  const deferBufferSwapRef = useRef(false);

  const positionBuffer = useCallback((buf: ZoomBuffer) => {
    const origin = map.getPixelOrigin();
    buf.canvas.style.left = `${buf.topLeftWorldPx.x - origin.x}px`;
    buf.canvas.style.top = `${buf.topLeftWorldPx.y - origin.y}px`;
    buf.canvas.style.width = `${buf.canvasW}px`;
    buf.canvas.style.height = `${buf.canvasH}px`;
  }, [map]);

  const attachBuffer = useCallback((buf: ZoomBuffer) => {
    const pane = paneRef.current;
    if (!pane) return;
    if (canvasRef.current && canvasRef.current !== buf.canvas) canvasRef.current.remove();
    if (buf.canvas.parentElement !== pane) pane.appendChild(buf.canvas);
    canvasRef.current = buf.canvas;
    positionBuffer(buf);
  }, [positionBuffer]);

  const paintZoomLevel = useCallback((zoom: number, center: L.LatLng, size: L.Point): ZoomBuffer => {
    const existing = cacheRef.current.get(zoom);
    const canvas = existing?.canvas ?? document.createElement("canvas");
    const buf = paintBuffer(canvas, center, zoom, size, gateCacheRef.current);
    cacheRef.current.set(zoom, buf);
    return buf;
  }, []);

  // Set right after refreshCurrent itself is defined below — a plain ref
  // rather than a direct reference, which would make scheduleGateFetch
  // (and everything that depends on it) get recreated on every
  // refreshCurrent identity change.
  const refreshCurrentRef = useRef<(() => void) | null>(null);

  // Only once zoomed in past GATES_MIN_ZOOM — real gate/apron/terminal
  // data is both invisible and pointless to fetch any wider than that.
  // map.getBounds() (not the padded buffer bounds paintBuffer itself
  // uses) is deliberate here: fetching a little past what's drawn is
  // fine, fetching for an airport nobody's actually looking at yet
  // isn't worth a real network request to OpenStreetMap's shared
  // Overpass instance.
  const scheduleGateFetch = useCallback((zoom: number) => {
    if (zoom < GATES_MIN_ZOOM) return;
    const bounds = map.getBounds();
    for (const ap of WORLD_AIRPORTS) {
      if (!bounds.contains([ap.pos[1], ap.pos[0]])) continue;
      if (gateCacheRef.current.has(ap.code) || gateFetchingRef.current.has(ap.code)) continue;
      gateFetchingRef.current.add(ap.code);
      fetchAirportGates(ap.code, ap.pos[1], ap.pos[0])
        .then((features) => {
          gateCacheRef.current.set(ap.code, features);
          // Every gate-eligible zoom level currently cached, not just the
          // live one — the background fill (scheduleFill) can have
          // already pre-rendered a neighboring zoom level (e.g. 14 while
          // this fetch was for 15) before this data existed, and
          // showZoomLevel trusts a cache hit as a free swap with no
          // repaint. Left alone, zooming to that neighbor later would
          // silently show the gate-less bitmap from before this fetch
          // landed — content missing, not just stale in place. Purging
          // (not repainting each one directly) is enough: showZoomLevel's
          // own cache-miss path repaints on next visit, and scheduleFill
          // — called by every zoomend — backfills the rest.
          for (const [z] of cacheRef.current) {
            if (z >= GATES_MIN_ZOOM) cacheRef.current.delete(z);
          }
          // The zoom level this fetch was originally for might not be
          // current anymore by the time it resolves — repainting
          // whatever's current now is still correct either way (a no-op
          // paint if this airport isn't even in view there), just
          // occasionally repaints a level that didn't need it, which is
          // cheap enough not to be worth tracking "is this still
          // relevant" for.
          refreshCurrentRef.current?.();
        })
        .catch(() => {})
        .finally(() => gateFetchingRef.current.delete(ap.code));
    }
  }, [map]);

  // A real animated zoom compatible with this theme's static pre-rendered
  // buffers — flyTo (what FollowSelected in FlightMap.tsx uses for the
  // default theme) can't be reused here: it drives the transition by
  // continuously changing the map's *actual* fractional zoom frame to
  // frame, re-deriving every pane position from that changing scale —
  // fine for a raster TileLayer, which re-renders fresh tiles at whatever
  // fractional zoom it's asked for, but this theme's buffers are each
  // pre-rendered for one fixed integer zoom, so flyTo's continuously-
  // changing scale reference reads as the buffer drifting out of
  // alignment with where the map now thinks it is — the exact "races
  // past the swap" glitch documented (and worked around by disabling
  // animation entirely) further up this file.
  //
  // Leaflet's *other* built-in zoom transition — the plain CSS one
  // setView(...,{animate:true}) normally plays, gated by _zoomAnimated
  // (disabled theme-wide in the mount effect above) — works completely
  // differently and *does* fit: it treats the pane's current content as
  // a static bitmap, CSS-scales/translates that bitmap for ~250ms, then
  // snaps to real content only once the transition ends. A static canvas
  // buffer is exactly the kind of content that transform can stretch
  // correctly, the same way it already stretches old raster tiles on the
  // default theme. So: re-enable _zoomAnimated for just this one
  // transition, use setView (not flyTo), and tell zoomstart (via
  // deferBufferSwapRef) to leave the *current* buffer in place rather
  // than swapping to the target one immediately — that swap now belongs
  // at zoomend, once the CSS transition has actually finished and the
  // map is really sitting at the integer target zoom.
  const smoothZoomTo = useCallback(
    (target: L.LatLngExpression, zoom: number) => {
      const mapInternal = map as unknown as { _zoomAnimated: boolean };
      deferBufferSwapRef.current = true;
      mapInternal._zoomAnimated = true;
      map.setView(target, zoom, { animate: true });
      map.once("zoomend", () => {
        mapInternal._zoomAnimated = false;
      });
    },
    [map],
  );

  // Clicking an airport's dot below GATES_MIN_ZOOM (see the click handler
  // in useMapEvents below) jumps straight to it — fetches the same real
  // gate/apron/terminal/hangar geometry scheduleGateFetch would eventually
  // fetch anyway once zoomed in this far normally, fits the view to it
  // (plus this airport's own runway centerlines, which can extend well
  // past its buildings) so everything actually built there ends up on
  // screen, and caches the result the same way so a later normal zoom-in
  // doesn't refetch it. Falls back to a fixed close zoom, not a
  // deliberately-empty view, when there's nothing to fit bounds to —  a
  // small airport OSM has no gate data for, or the fetch failing outright.
  //
  // Always recenters synchronously, right here, never from the network
  // callback below — real feedback: a cache-miss used to wait on the
  // Overpass fetch (which can take seconds) before doing *anything*
  // visually, so a user who'd since started panning elsewhere on their
  // own got yanked back the instant that fetch happened to resolve. The
  // fetch now only ever populates gateCacheRef for whoever looks at this
  // airport next (a later click, or the ambient scheduleGateFetch/
  // refreshCurrent redraw once zoomed in this far normally) — it no
  // longer has any way to move the view itself.
  const zoomToAirport = useCallback((ap: (typeof WORLD_AIRPORTS)[number]) => {
    const [lon, lat] = ap.pos;
    const fallback = () => smoothZoomTo([lat, lon], AIRPORT_ZOOM_TO_FALLBACK_ZOOM);
    const fitToFeatures = (features: AirportGateFeature[]) => {
      const bounds = L.latLngBounds([]);
      for (const feature of features) {
        for (const [flon, flat] of feature.ring) bounds.extend([flat, flon]);
      }
      if (ap.runways) {
        for (const seg of ap.runways) for (const [rlon, rlat] of seg) bounds.extend([rlat, rlon]);
      }
      if (bounds.isValid()) {
        // fitBounds computes its own center/zoom then defers to the same
        // setView internally — animate:true reaches the same _zoomAnimated
        // CSS path smoothZoomTo does, just via fitBounds' own call rather
        // than a target [lat,lon]/zoom this callback doesn't have yet.
        const mapInternal = map as unknown as { _zoomAnimated: boolean };
        deferBufferSwapRef.current = true;
        mapInternal._zoomAnimated = true;
        map.fitBounds(bounds, { padding: [40, 40], animate: true });
        map.once("zoomend", () => {
          mapInternal._zoomAnimated = false;
        });
      } else {
        fallback();
      }
    };
    const cached = gateCacheRef.current.get(ap.code);
    if (cached) {
      fitToFeatures(cached);
      return;
    }
    fallback();
    fetchAirportGates(ap.code, lat, lon)
      .then((features) => gateCacheRef.current.set(ap.code, features))
      .catch(() => {});
  }, [map, smoothZoomTo]);

  // Shared by the click and hover handlers below: below GATES_MIN_ZOOM an
  // airport's dot is the only thing marking where it is (its real outline
  // isn't drawn/visible yet), so both "did this click hit an airport" and
  // "is the cursor over one" are the same nearest-within-radius query.
  // Nearest, not first-match: a crowded area can have several dots within
  // AIRPORT_CLICK_RADIUS_PX of any given point.
  const nearestAirport = useCallback(
    (point: L.Point): (typeof WORLD_AIRPORTS)[number] | null => {
      if (map.getZoom() >= GATES_MIN_ZOOM) return null;
      const viewBounds = map.getBounds();
      let nearest: (typeof WORLD_AIRPORTS)[number] | null = null;
      let nearestDist = AIRPORT_CLICK_RADIUS_PX;
      for (const ap of WORLD_AIRPORTS) {
        if (!viewBounds.contains([ap.pos[1], ap.pos[0]])) continue;
        const dist = point.distanceTo(map.latLngToContainerPoint([ap.pos[1], ap.pos[0]]));
        if (dist < nearestDist) {
          nearestDist = dist;
          nearest = ap;
        }
      }
      return nearest;
    },
    [map],
  );

  // A capture-phase listener on the map's own container, not
  // useMapEvents' click (a bubble-phase Leaflet event) — this pane sits
  // under markerPane (see the pane-creation effect below) and is
  // pointer-events:none itself, so a plane/cluster marker (or any other
  // real DOM control) visually on or near an airport's dot already gets
  // the click first and, per Leaflet's own Marker/DomEvent handling,
  // stops it from ever bubbling up to a plain map 'click' listener at
  // all — an airport under a busy cluster of traffic (exactly the case
  // this exists for) was then simply unclickable. Capturing here, ahead
  // of every bubble-phase listener a marker registers on itself, means
  // an airport hit is checked before anything else gets a chance to
  // claim the click, and explicitly stopping propagation on a hit keeps
  // that marker's own click (select an aircraft, zoom into a cluster)
  // from *also* firing for the same click.
  // Real feedback: panning would sometimes "select" a nearby airport on
  // its own. The browser's native 'click' event doesn't actually require
  // zero movement between mousedown and mouseup — a short drag (a slow
  // pan, or the tail end of a longer one) still fires one, and this
  // handler had no way to tell that apart from an honest stationary
  // click. mousedownPointRef records where the gesture *started*; a
  // click is only treated as a real click here if it ended within
  // CLICK_DRAG_TOLERANCE_PX of that, otherwise it's a pan that happened
  // to end near an airport, not a click on one.
  const mousedownPointRef = useRef<L.Point | null>(null);
  useEffect(() => {
    const container = map.getContainer();
    function handleDown(e: MouseEvent) {
      mousedownPointRef.current = map.mouseEventToContainerPoint(e);
    }
    function handleCapture(e: MouseEvent) {
      const point = map.mouseEventToContainerPoint(e);
      const start = mousedownPointRef.current;
      if (start && point.distanceTo(start) > CLICK_DRAG_TOLERANCE_PX) return;
      const nearest = nearestAirport(point);
      if (!nearest) return;
      e.stopPropagation();
      zoomToAirport(nearest);
      onAirportSelect?.({ code: nearest.code, name: nearest.name, lat: nearest.pos[1], lon: nearest.pos[0] });
    }
    container.addEventListener("mousedown", handleDown, true);
    container.addEventListener("click", handleCapture, true);
    return () => {
      container.removeEventListener("mousedown", handleDown, true);
      container.removeEventListener("click", handleCapture, true);
    };
  }, [map, nearestAirport, zoomToAirport, onAirportSelect]);

  // Cursor feedback for the same hit-test the click handler above uses —
  // without this an airport dot looked like plain decoration below
  // GATES_MIN_ZOOM, identical to the grab cursor everywhere else on the
  // map, with nothing hinting it's clickable. Toggles a class rather than
  // writing container.style.cursor directly so Leaflet's own drag-state
  // classes (.leaflet-grab/.leaflet-dragging, which set cursor via CSS
  // too) don't get silently overridden by a stale inline style once the
  // cursor moves off an airport — see .leaflet-container--airport-hover
  // in FlightMap.css for the actual cursor: pointer rule, specific enough
  // to win over Leaflet's own class-based one.
  useEffect(() => {
    const container = map.getContainer();
    function handleMove(e: MouseEvent) {
      const over = nearestAirport(map.mouseEventToContainerPoint(e)) != null;
      container.classList.toggle("leaflet-container--airport-hover", over);
    }
    function handleLeave() {
      container.classList.remove("leaflet-container--airport-hover");
    }
    container.addEventListener("mousemove", handleMove);
    container.addEventListener("mouseleave", handleLeave);
    return () => {
      container.removeEventListener("mousemove", handleMove);
      container.removeEventListener("mouseleave", handleLeave);
      container.classList.remove("leaflet-container--airport-hover");
    };
  }, [map, nearestAirport]);

  // Refreshes/attaches whatever the map's current zoom level is, right
  // now — used for the initial paint, every pan refresh, and the
  // moveend/resize safety nets. Always repaints (never trusts a cache
  // hit) since "current zoom" is exactly the one level whose center is
  // continuously moving.
  const refreshCurrent = useCallback(() => {
    const zoom = Math.round(map.getZoom());
    const buf = paintZoomLevel(zoom, map.getCenter(), map.getSize());
    attachBuffer(buf);
    scheduleGateFetch(zoom);
  }, [map, paintZoomLevel, attachBuffer, scheduleGateFetch]);
  refreshCurrentRef.current = refreshCurrent;

  // Attaches `zoom`'s buffer, painting it on the spot only on a cache
  // miss — the path a zoomstart/zoomend takes, where a hit should be a
  // free swap (no drawing at all) and a miss is the exception, not the
  // rule, once the background fill below has had a chance to run.
  const showZoomLevel = useCallback((zoom: number) => {
    const cached = cacheRef.current.get(zoom);
    attachBuffer(cached ?? paintZoomLevel(zoom, map.getCenter(), map.getSize()));
    scheduleGateFetch(zoom);
  }, [map, attachBuffer, paintZoomLevel, scheduleGateFetch]);

  // Background-fills every missing zoom level in the map's real range
  // (minZoom..maxZoom, capped defensively by ZOOM_CACHE_MAX_LEVELS), one
  // level per idle slice so any single slice stays cheap even though
  // painting a whole level isn't free. No eviction: at ~17 real levels
  // in this app, keeping every one of them as a full padded-viewport
  // bitmap is a deliberate, confirmed-affordable memory trade for every
  // zoom level being a free swap forever after, not just the immediate
  // neighbor. Ordered outward from the current level (0, -1, +1, -2,
  // +2, ...) so whichever levels the user is actually near get cached
  // soonest, even though the fill eventually covers the whole range.
  const scheduleFill = useCallback(() => {
    cancelIdle(fillHandleRef.current);
    const run = () => {
      fillHandleRef.current = null;
      const zoom = Math.round(map.getZoom());
      const minZoom = Math.max(0, Math.round(map.getMinZoom()));
      const maxZoomRaw = Math.round(map.getMaxZoom());
      const maxZoom = Number.isFinite(maxZoomRaw) ? maxZoomRaw : minZoom + ZOOM_CACHE_MAX_LEVELS - 1;
      for (let d = 0; d <= maxZoom - minZoom; d++) {
        const candidates = d === 0 ? [zoom] : [zoom - d, zoom + d];
        for (const z of candidates) {
          if (z < minZoom || z > maxZoom) continue;
          if (!cacheRef.current.has(z)) {
            paintZoomLevel(z, map.getCenter(), map.getSize());
            fillHandleRef.current = scheduleIdle(run);
            return;
          }
        }
      }
    };
    fillHandleRef.current = scheduleIdle(run);
  }, [map, paintZoomLevel]);

  useEffect(() => {
    // Same z-index as tilePane (200, set by Leaflet core regardless of
    // whether a TileLayer is mounted) — the always-present but blank
    // TileLayer (see BLANK_TILE_URL in FlightMap.tsx) mounts first, so
    // this pane's own DOM insertion happens after it and naturally
    // stacks on top at that equal z-index, safely under markerPane's 600.
    const pane = map.createPane("vectorBasemap");
    pane.style.zIndex = "200";
    pane.style.pointerEvents = "none";
    paneRef.current = pane;

    // Leaflet's animated zoom is a fixed ~250ms CSS transition, gated by
    // a live internal flag (_zoomAnimated) that _tryAnimatedZoom checks
    // on every zoom call — not the public zoomAnimation option, which is
    // only read once at map construction to seed that flag, so setting
    // it later is the only way to actually change this at runtime.
    // Undocumented/private (see the CRS cast up top for the same kind of
    // justified reach into non-typed internals), but a deliberate trade
    // here: that transition exists to smooth a *transition toward* new
    // content: tiles fading/scaling in, markers repositioning. This
    // theme's whole zoom cache is built to have the destination's
    // correct content ready *before* the animation would even start, so
    // the transition is pure added latency with nothing left to smooth.
    // Scoped to exactly this theme being mounted; restored on unmount so
    // the default theme's tile-based zoom keeps its normal animation.
    const mapInternal = map as unknown as { _zoomAnimated: boolean };
    const previousZoomAnimated = mapInternal._zoomAnimated;
    mapInternal._zoomAnimated = false;

    refreshCurrent();
    scheduleFill();

    return () => {
      mapInternal._zoomAnimated = previousZoomAnimated;
      cancelIdle(fillHandleRef.current);
      fillHandleRef.current = null;
      if (panThrottleRef.current != null) {
        clearTimeout(panThrottleRef.current);
        panThrottleRef.current = null;
      }
      canvasRef.current = null;
      cacheRef.current.clear();
      map.getPane("vectorBasemap")?.remove();
    };
    // Mount/unmount only — refreshCurrent/scheduleFill read live map
    // state through `map` itself (stable for the component's lifetime),
    // not through props/state that would need this to re-run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map]);

  // Continuous 'move' fires up to every frame during a drag; the
  // throttle is what keeps this from becoming the "redraw on every
  // move" cost the buffer padding above exists to avoid, while still
  // extending the buffer in whatever direction the drag actually goes
  // well before it's done, not only once it stops.
  const schedulePanRefresh = useCallback(() => {
    if (panThrottleRef.current != null) return;
    panThrottleRef.current = setTimeout(() => {
      panThrottleRef.current = null;
      refreshCurrent();
    }, PAN_REFRESH_THROTTLE_MS);
  }, [refreshCurrent]);

  useMapEvents({
    move: schedulePanRefresh,
    moveend: () => {
      if (panThrottleRef.current != null) {
        clearTimeout(panThrottleRef.current);
        panThrottleRef.current = null;
      }
      refreshCurrent();
    },
    // Leaflet already knows the destination zoom the instant the
    // gesture starts (before the animation plays) — showing it here
    // rather than at zoomend means the correct content is in place
    // throughout the animation instead of popping in only once it ends.
    // Skipped when deferBufferSwapRef is set (see smoothZoomTo above): a
    // smooth programmatic zoom wants the *current* buffer left alone
    // here, riding Leaflet's own CSS transition, with the swap to the
    // target buffer happening at zoomend instead once that transition's
    // actually done.
    zoomstart: () => {
      if (!deferBufferSwapRef.current) showZoomLevel(Math.round(map.getZoom()));
    },
    zoomend: () => {
      showZoomLevel(Math.round(map.getZoom()));
      deferBufferSwapRef.current = false;
      scheduleFill();
    },
    resize: () => {
      // Every cached buffer's dimensions are tied to the old container
      // size — all of them are stale at once, not just the current one.
      for (const buf of cacheRef.current.values()) {
        if (buf.canvas !== canvasRef.current) buf.canvas.remove();
      }
      cacheRef.current.clear();
      refreshCurrent();
      scheduleFill();
    },
  });

  return null;
}
