/**
 * The mocked OpenFreeMap tileset — the cyberpunk style's only vector source.
 *
 * `vector_layers` must list every `source-layer` the style references
 * (src/cyberpunkMapStyle.ts draws from `openmaptiles`: landcover, landuse,
 * water, waterway, transportation, building, aeroway, boundary, place).
 * MapLibre validates every layer's `source-layer` against this document when
 * the style loads, and logs
 * `Source layer "<id>" does not exist on source "openmaptiles"`
 * for each one it cannot find. The old empty array made every test run carry
 * those errors (the #106 run saw them on place-country/place-city) — noise
 * that a spec asserting a clean console would fail on for the wrong reason.
 * The tiles themselves are still served empty by each spec's tile route; only
 * the ids matter here, so keep this list in step with the `source-layer`
 * values in src/cyberpunkMapStyle.ts.
 */
export const OPENFREEMAP_VECTOR_LAYERS = [
  "landcover",
  "landuse",
  "water",
  "waterway",
  "transportation",
  "building",
  "aeroway",
  "boundary",
  "place",
] as const;

/** The TileJSON the tests serve for `https://tiles.openfreemap.org/planet`. */
export const OPENFREEMAP_TILEJSON = {
  tilejson: "3.0.0",
  tiles: ["https://tiles.openfreemap.org/t/{z}/{x}/{y}.pbf"],
  minzoom: 0,
  maxzoom: 14,
  vector_layers: OPENFREEMAP_VECTOR_LAYERS.map((id) => ({ id, fields: {}, minzoom: 0, maxzoom: 14 })),
};
