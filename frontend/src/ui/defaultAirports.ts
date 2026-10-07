import type { ExpressionSpecification } from "maplibre-gl";
import type { FlightMap, MapHit, Point, RenderedAirport } from "../map/map";
import { AIRPORTS } from "../worldMapData";
import type { AirportSelection } from "../types/flight";
import { canvas, cssToken, drawLabel, measureLabel, serveImages, type LabelStyle } from "../map/glImages";
import { PLANES_LAYER } from "../map/planes";
import { ROUTE_LAYER_ID } from "../map/route";

/**
 * How far down Natural Earth's significance ranking to draw, per zoom
 * level: index is the zoom, value is the highest `rank` still shown (lower
 * rank = more significant). Zooms past the end of the array show
 * everything. See DefaultAirports.tsx's original comment for the
 * per-zoom counts this produces worldwide.
 */
const MAX_RANK_BY_ZOOM = [2, 2, 2, 2, 3, 4, 6, 7, 8];

const SOURCE = "airports";
const LAYER = "airports";
const IMAGE_PREFIX = "airport:";
// The dot's box, and how far a click may land from its centre and still hit it, px.
const DOT_PX = 10;
const DOT_BOX_PX = 12;
const HIT_PX = DOT_BOX_PX / 2 + 1;
// The code chip starts this far right of the dot's centre.
const LABEL_LEFT_PX = DOT_BOX_PX / 2 + 4;

// The rank filter, in MapLibre zoom (the app's minus one, see map/map.ts):
// at app zoom level L (floored) airports up to MAX_RANK_BY_ZOOM[L] are drawn.
function rankFilter(): ExpressionSpecification {
  const step: unknown[] = ["step", ["zoom"], MAX_RANK_BY_ZOOM[1]];
  for (let level = 2; level <= MAX_RANK_BY_ZOOM.length; level++) step.push(level - 1, MAX_RANK_BY_ZOOM[level] ?? 99);
  return ["<=", ["get", "rank"], step] as unknown as ExpressionSpecification;
}

/**
 * Every airport on the map: a dot plus its IATA code, clickable to open the
 * airport dossier. Loaded lazily (see main.ts) so worldMapData.ts's ~160KB
 * stays out of the main bundle.
 *
 * Drawn by the map itself, in one symbol layer under the trail and the
 * planes (so an airport's code never covers the selected plane). Each
 * airport's dot and code chip is one image, drawn on demand from the theme's
 * airport tokens. The rank rule is a zoom filter on the layer; the map only
 * draws the tiles in view.
 */
export function mount(map: FlightMap, onAirportSelect: (ap: AirportSelection) => void): () => void {
  const gl = map.gl;
  let added = false;
  let destroyed = false;

  map.whenStyleReady(() => {
    if (destroyed) return;
    const dotColor = cssToken("--color-airport", "#e2ddc9");
    const dotFill = cssToken("--color-airport-fill", "#1a1a1a");
    const label: LabelStyle = {
      font: `700 10px ${cssToken("--font-data", "monospace")}`,
      color: dotColor,
      background: cssToken("--color-airport-label-bg", "rgba(20, 20, 20, 0.75)"),
      padX: 4,
      padY: 1,
      radius: 2,
    };
    serveImages(
      map,
      IMAGE_PREFIX,
      (code) => {
        const text = measureLabel(code, label);
        const height = Math.max(DOT_BOX_PX, text.height);
        const { ctx, done } = canvas(LABEL_LEFT_PX + DOT_BOX_PX / 2 + text.width, height, Math.max(2, window.devicePixelRatio || 1));
        // The image's left edge is DOT_BOX_PX / 2 left of the airport (icon-offset below).
        ctx.beginPath();
        ctx.arc(DOT_BOX_PX / 2, height / 2, DOT_PX / 2 - 1, 0, 2 * Math.PI);
        ctx.fillStyle = dotFill;
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = dotColor;
        ctx.stroke();
        drawLabel(ctx, code, label, DOT_BOX_PX / 2 + LABEL_LEFT_PX, (height - text.height) / 2);
        return done();
      },
      label.font,
    );

    gl.addSource(SOURCE, {
      type: "geojson",
      data: {
        type: "FeatureCollection",
        features: AIRPORTS.map((ap) => ({ type: "Feature", properties: { code: ap.code, name: ap.name, rank: ap.rank }, geometry: { type: "Point", coordinates: ap.pos } })),
      },
    });
    gl.addLayer(
      {
        id: LAYER,
        type: "symbol",
        source: SOURCE,
        filter: rankFilter(),
        layout: {
          "icon-image": ["concat", IMAGE_PREFIX, ["get", "code"]],
          "icon-anchor": "left",
          "icon-offset": [-DOT_BOX_PX / 2, 0],
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
        },
      },
      [ROUTE_LAYER_ID, PLANES_LAYER].find((id) => gl.getLayer(id)),
    );
    added = true;
  });

  const rendered = (box?: [[number, number], [number, number]]) => (added ? gl.queryRenderedFeatures(box ?? undefined, { layers: [LAYER] }) : []);

  map.addHitTarget((pt: Point): MapHit | null => {
    let best: MapHit | null = null;
    for (const f of rendered([
      [pt.x - HIT_PX, pt.y - HIT_PX],
      [pt.x + HIT_PX, pt.y + HIT_PX],
    ])) {
      const [lon, lat] = (f.geometry as GeoJSON.Point).coordinates;
      const at = map.project(lat, lon);
      // Only the dot is a target (the code chip never blocks a drag or a plane).
      if (Math.abs(at.x - pt.x) > HIT_PX || Math.abs(at.y - pt.y) > HIT_PX) continue;
      const distance = Math.hypot(at.x - pt.x, at.y - pt.y);
      if (best && best.distance <= distance) continue;
      const { code, name } = f.properties as { code: string; name: string };
      best = { priority: 1, distance, activate: () => onAirportSelect({ code, name, lat, lon }) };
    }
    return best;
  });

  map.renderedAirports = (): RenderedAirport[] => {
    const out = new Map<string, RenderedAirport>();
    for (const f of rendered()) {
      const [lon, lat] = (f.geometry as GeoJSON.Point).coordinates;
      const code = (f.properties as { code: string }).code;
      const at = map.project(lat, lon);
      out.set(`${code}@${lat.toFixed(3)},${lon.toFixed(3)}`, { code, lat, lon, x: at.x, y: at.y });
    }
    return Array.from(out.values());
  };

  return () => {
    destroyed = true;
    if (added && gl.getStyle()) {
      gl.removeLayer(LAYER);
      gl.removeSource(SOURCE);
    }
    added = false;
    map.renderedAirports = () => [];
  };
}
