import type { StyleSpecification } from "maplibre-gl";
import { GRATICULE_COARSE, GRATICULE_FINE } from "./graticule";

/**
 * The cyberpunk theme's basemap, as a MapLibre vector-tile style.
 *
 * Replaces a hand-written canvas renderer that drew the world from Natural
 * Earth 1:10m/1:50m geometry bundled into worldMapData.ts. That dataset is
 * built for ~1:10,000,000 scale: it tops out around zoom 7-8 and contains
 * no roads, no buildings and no landuse at any zoom, while the app zooms to
 * 18 — so past ~z9 the map was empty apart from runway centerlines, and
 * airport detail had to be patched in per-airport by live Overpass queries
 * that took seconds to arrive.
 *
 * Vector tiles solve both at once. The OpenMapTiles `aeroway` layer carries
 * apron/runway/taxiway/gate as real geometry, globally, at every zoom —
 * exactly what the Overpass proxy used to fetch one airport at a time — so
 * airport layouts are simply present the moment you can see them, with no
 * request of our own. `building` and `transportation` supply the street-
 * level detail the old dataset structurally could not.
 *
 * Source is OpenFreeMap's planet tiles: unmodified OpenMapTiles schema, no
 * API key, no registration, no usage limits, and self-hostable behind the
 * nginx this app already ships if we ever want the NAS to own it.
 *
 * Known limitation: labels are Noto Sans, not the theme's Rajdhani /
 * JetBrains Mono pairing, because a style can only use fonts its glyph
 * endpoint serves and OpenFreeMap's serves Noto. Fixable by generating a
 * glyph range from those two faces (fontnik) and hosting it alongside the
 * app — a build-time job, deliberately not done here. Aircraft and airport
 * labels are real DOM elements rendered by React, so they keep the theme's
 * own fonts regardless; this only affects place names baked into the map.
 */

// Carried over verbatim from the canvas renderer so the two themes stay
// recognisably the same map. Land is the *background* here: OpenMapTiles
// has no land polygon, it has water polygons drawn over whatever is
// beneath — the inverse of the canvas model, where ocean was the
// background and land was painted on top.
const LAND = "#6b1420";
const LAND_OUTLINE = "#ff2d3d";
const BORDER_COLOR = "rgba(60, 224, 255, 0.4)";
const WATER_DEEP = "#061218";
const WATER_SHALLOW = "#0d2a33";
const WATER_OUTLINE = "rgba(60, 224, 255, 0.5)";
const RIVER_COLOR = "rgba(60, 224, 255, 0.4)";
const CITY_LABEL_COLOR = "rgba(226, 221, 201, 0.85)";
const COUNTRY_LABEL_COLOR = "rgba(125, 144, 163, 0.8)";
const URBAN_FILL_COLOR = "rgba(226, 221, 201, 0.08)";
const RUNWAY_COLOR = "rgba(226, 221, 201, 0.55)";
// Stronger than the canvas renderer's equivalents. There, these were drawn
// over bare land with nothing else at that zoom to compete with; here they
// sit on top of roads, buildings and landuse, and at the original opacities
// the airport stopped reading as the subject of the frame at z14+ — it
// blended into the same red as everything around it. The apron is
// deliberately a dark, mostly-opaque tarmac tone rather than a light wash:
// contrast against the red land is what makes the airport's footprint
// legible at a glance, which is the entire point of showing it.
const APRON_FILL_COLOR = "rgba(16, 40, 48, 0.72)";
const APRON_OUTLINE_COLOR = "rgba(125, 144, 163, 0.55)";
const TERMINAL_FILL_COLOR = "rgba(226, 221, 201, 0.26)";
const TERMINAL_OUTLINE_COLOR = "rgba(226, 221, 201, 0.75)";
// The canvas renderer's own grid colour, unchanged.
const GRID_COLOR = "rgba(255, 45, 61, 0.16)";

// No canvas equivalent — this is the detail the bundled dataset couldn't
// carry. Roads read as a dim cyan circuit trace over the red land,
// brightening with road class; buildings as a faint fill with a slightly
// hotter edge so blocks read as blocks rather than one smear.
const ROAD_MAJOR = "rgba(60, 224, 255, 0.5)";
const ROAD_MINOR = "rgba(60, 224, 255, 0.2)";
// Deliberately a dark red rather than the near-black first tried: a true
// black casing under every road class turned the frame into a heavy dark
// mesh at z12+ that dominated everything else on the map. This only has to
// separate a road from the land directly beneath it.
const ROAD_CASING = "rgba(38, 8, 13, 0.55)";
const BUILDING_FILL = "rgba(255, 45, 61, 0.18)";
const BUILDING_OUTLINE = "rgba(255, 122, 90, 0.45)";

const MAJOR_ROAD_CLASSES = ["motorway", "trunk", "primary", "secondary", "tertiary"];

export const CYBERPUNK_STYLE: StyleSpecification = {
  version: 8,
  glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
  sources: {
    openmaptiles: { type: "vector", url: "https://tiles.openfreemap.org/planet" },
    graticuleCoarse: { type: "geojson", data: GRATICULE_COARSE },
    graticuleFine: { type: "geojson", data: GRATICULE_FINE },
  },
  layers: [
    { id: "background", type: "background", paint: { "background-color": LAND } },

    {
      id: "landcover",
      type: "fill",
      source: "openmaptiles",
      "source-layer": "landcover",
      paint: { "fill-color": "rgba(255, 45, 61, 0.06)" },
    },
    {
      id: "landuse-urban",
      type: "fill",
      source: "openmaptiles",
      "source-layer": "landuse",
      filter: ["match", ["get", "class"], ["residential", "suburb", "quarter", "neighbourhood"], true, false],
      paint: { "fill-color": URBAN_FILL_COLOR },
    },

    {
      id: "water",
      type: "fill",
      source: "openmaptiles",
      "source-layer": "water",
      paint: {
        // Deep ocean sits darker than inland water, which the schema keeps
        // in the same layer — interpolating by zoom approximates the
        // canvas theme's two distinct treatments without needing to tell
        // them apart. A narrow range: wider, and mid zooms landed on a
        // flat near-black that lost the archipelago detail entirely.
        "fill-color": ["interpolate", ["linear"], ["zoom"], 3, WATER_DEEP, 6, WATER_SHALLOW],
      },
    },
    // The canvas theme's most recognisable single trait: every landmass
    // outlined in hot red. Stroked on the water polygons, which share that
    // boundary exactly. Eased off as you zoom in — at z12+ every pond and
    // inlet has an outline and it stops reading as coastline.
    {
      id: "coastline-glow",
      type: "line",
      source: "openmaptiles",
      "source-layer": "water",
      paint: {
        "line-color": LAND_OUTLINE,
        "line-width": ["interpolate", ["linear"], ["zoom"], 2, 0.8, 10, 1.6],
        "line-opacity": ["interpolate", ["linear"], ["zoom"], 8, 0.9, 13, 0.35],
      },
    },
    {
      id: "waterway",
      type: "line",
      source: "openmaptiles",
      "source-layer": "waterway",
      paint: {
        "line-color": RIVER_COLOR,
        "line-width": ["interpolate", ["linear"], ["zoom"], 6, 0.5, 14, 2],
      },
    },

    // Graticule, above the terrain fills so it reads as an overlay grid but
    // below roads and everything at airport scale, which it must never
    // compete with. The two densities cross-fade: coarse carries the wide
    // views, fine takes over once 2.5° spacing exceeds the viewport, and
    // both are gone by the zoom where airport layout is the subject.
    {
      id: "graticule-coarse",
      type: "line",
      source: "graticuleCoarse",
      paint: {
        "line-color": GRID_COLOR,
        "line-width": 1,
        "line-opacity": ["interpolate", ["linear"], ["zoom"], 2, 1, 7, 1, 9, 0],
      },
    },
    {
      id: "graticule-fine",
      type: "line",
      source: "graticuleFine",
      minzoom: 6,
      paint: {
        "line-color": GRID_COLOR,
        "line-width": 1,
        "line-opacity": ["interpolate", ["linear"], ["zoom"], 6, 0, 8, 1, 11, 1, 13, 0],
      },
    },

    // Roads. Casing only under the major classes — casing every service
    // road and footpath was what made the first cut read as a dark mesh
    // rather than a road network.
    {
      id: "road-casing",
      type: "line",
      source: "openmaptiles",
      "source-layer": "transportation",
      minzoom: 11,
      filter: ["match", ["get", "class"], MAJOR_ROAD_CLASSES, true, false],
      paint: {
        "line-color": ROAD_CASING,
        "line-width": ["interpolate", ["linear"], ["zoom"], 11, 2, 18, 11],
      },
    },
    {
      id: "road-minor",
      type: "line",
      source: "openmaptiles",
      "source-layer": "transportation",
      minzoom: 12,
      filter: ["match", ["get", "class"], ["minor", "service", "track", "path"], true, false],
      paint: {
        "line-color": ROAD_MINOR,
        "line-width": ["interpolate", ["linear"], ["zoom"], 12, 0.4, 18, 4],
      },
    },
    {
      id: "road-major",
      type: "line",
      source: "openmaptiles",
      "source-layer": "transportation",
      minzoom: 6,
      filter: ["match", ["get", "class"], MAJOR_ROAD_CLASSES, true, false],
      paint: {
        "line-color": ROAD_MAJOR,
        "line-width": ["interpolate", ["linear"], ["zoom"], 6, 0.4, 12, 1.4, 18, 6],
      },
    },

    {
      id: "building",
      type: "fill",
      source: "openmaptiles",
      "source-layer": "building",
      minzoom: 13,
      paint: { "fill-color": BUILDING_FILL, "fill-outline-color": BUILDING_OUTLINE },
    },

    // Aeroway, drawn above roads and buildings: at these zooms the airport
    // is the subject, and its aprons and terminals should not be crossed by
    // the service roads that run over them in the source data. minzoom 9
    // rather than the 11 most styles use — "visible from very high up" is
    // the whole point, and it's free now that no request is involved.
    {
      id: "aeroway-fill",
      type: "fill",
      source: "openmaptiles",
      "source-layer": "aeroway",
      minzoom: 9,
      filter: ["match", ["geometry-type"], ["Polygon", "MultiPolygon"], true, false],
      paint: {
        "fill-color": ["match", ["get", "class"], "apron", APRON_FILL_COLOR, TERMINAL_FILL_COLOR],
        "fill-outline-color": ["match", ["get", "class"], "apron", APRON_OUTLINE_COLOR, TERMINAL_OUTLINE_COLOR],
      },
    },
    {
      id: "aeroway-taxiway",
      type: "line",
      source: "openmaptiles",
      "source-layer": "aeroway",
      minzoom: 11,
      filter: ["all",
        ["match", ["geometry-type"], ["LineString", "MultiLineString"], true, false],
        ["==", ["get", "class"], "taxiway"]],
      paint: {
        "line-color": APRON_OUTLINE_COLOR,
        "line-width": ["interpolate", ["linear"], ["zoom"], 11, 0.5, 17, 5],
      },
    },
    {
      id: "aeroway-runway",
      type: "line",
      source: "openmaptiles",
      "source-layer": "aeroway",
      minzoom: 9,
      filter: ["all",
        ["match", ["geometry-type"], ["LineString", "MultiLineString"], true, false],
        ["==", ["get", "class"], "runway"]],
      paint: {
        "line-color": RUNWAY_COLOR,
        "line-width": ["interpolate", ["linear"], ["zoom"], 9, 1.5, 14, 6, 17, 18],
      },
    },

    {
      id: "boundary-country",
      type: "line",
      source: "openmaptiles",
      "source-layer": "boundary",
      filter: ["<=", ["get", "admin_level"], 2],
      paint: {
        "line-color": BORDER_COLOR,
        "line-width": ["interpolate", ["linear"], ["zoom"], 2, 0.6, 8, 1.4],
      },
    },

    // Place labels only. Airports are deliberately NOT labelled here even
    // though the aerodrome_label layer carries iata/icao: DefaultAirports
    // renders every airport as a real Leaflet marker on both themes, so a
    // symbol layer here would double-label each one — which is exactly what
    // the first prototype did.
    {
      id: "place-country",
      type: "symbol",
      source: "openmaptiles",
      "source-layer": "place",
      filter: ["==", ["get", "class"], "country"],
      layout: {
        "text-field": ["coalesce", ["get", "name:en"], ["get", "name"]],
        "text-font": ["Noto Sans Bold"],
        "text-size": 13,
        "text-transform": "uppercase",
        "text-letter-spacing": 0.1,
      },
      paint: { "text-color": COUNTRY_LABEL_COLOR, "text-halo-color": WATER_DEEP, "text-halo-width": 1 },
    },
    {
      id: "place-city",
      type: "symbol",
      source: "openmaptiles",
      "source-layer": "place",
      filter: ["match", ["get", "class"], ["city", "town"], true, false],
      layout: {
        "text-field": ["coalesce", ["get", "name:en"], ["get", "name"]],
        "text-font": ["Noto Sans Regular"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 4, 10, 12, 14],
      },
      paint: { "text-color": CITY_LABEL_COLOR, "text-halo-color": WATER_DEEP, "text-halo-width": 1.2 },
    },
  ],
};
