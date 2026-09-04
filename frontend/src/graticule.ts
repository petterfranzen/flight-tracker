import type { FeatureCollection, LineString } from "geojson";

/**
 * The lat/long grid the old canvas basemap drew by hand, rebuilt as a
 * GeoJSON source MapLibre can style like any other layer.
 *
 * In EPSG:3857 both meridians and parallels are straight lines, so every
 * graticule line is a two-point LineString — the whole world grid is a few
 * hundred segments, small enough to build at module load and hand to
 * MapLibre inline rather than fetching or bundling it.
 *
 * Two densities rather than the canvas version's single fixed 2.5°: that
 * spacing reads as a HUD grid when the view spans a continent and
 * disappears entirely once you're over an airport, since consecutive lines
 * end up further apart than the viewport. The style fades between the two
 * by zoom so the grid stays present at every scale.
 */

// Latitude beyond which Mercator's vertical stretch makes the grid
// meaningless (and, at exactly ±90°, unprojectable). Matches the clamp the
// canvas renderer used for the same reason.
const MAX_LAT = 85;

function graticule(stepDeg: number): FeatureCollection<LineString> {
  const features: FeatureCollection<LineString>["features"] = [];

  for (let lon = -180; lon <= 180; lon += stepDeg) {
    features.push({
      type: "Feature",
      properties: {},
      geometry: { type: "LineString", coordinates: [[lon, -MAX_LAT], [lon, MAX_LAT]] },
    });
  }
  for (let lat = -MAX_LAT; lat <= MAX_LAT; lat += stepDeg) {
    features.push({
      type: "Feature",
      properties: {},
      geometry: { type: "LineString", coordinates: [[-180, lat], [180, lat]] },
    });
  }

  return { type: "FeatureCollection", features };
}

/** ~278km at the equator — the wide-view grid, same spacing the canvas used. */
export const GRATICULE_COARSE = graticule(2.5);

/** ~55km at the equator — takes over once the coarse grid outgrows the viewport. */
export const GRATICULE_FINE = graticule(0.5);
