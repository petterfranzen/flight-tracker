#!/usr/bin/env python3
"""Regenerates frontend/src/worldMapData.ts from Natural Earth + OurAirports
source data. Pure stdlib (json/csv/urllib/math) — no GIS libraries needed for
what this actually does (ring extraction, Douglas-Peucker simplification,
nearest-point matching).

Run from the repo root: python3 scripts/generate_world_map_data.py

Sources (fetched fresh, cached under scripts/.cache/ so re-runs while
tuning thresholds don't re-download ~10MB each time — delete that
directory to force a refresh):
  - Natural Earth 1:50m admin-0 countries, populated places, urban areas,
    rivers+lake-centerlines, and lakes, via the nvkelso/natural-earth-vector
    GeoJSON mirror (Natural Earth's own site has no stable direct-download
    URLs for individual layers).
  - Natural Earth 1:10m airports (needs 1:10m for airport detail; 1:50m
    doesn't carry one at all) — the same mirror.
  - OurAirports' open airports.csv + runways.csv, joined onto the Natural
    Earth airports by IATA code, for real runway centerlines Natural Earth
    itself doesn't carry.

This is the "not re-derivable from this file alone" gap the original
worldMapData.ts header flagged — checking this script in fixes that for
next time, rather than leaving the next resolution bump to reverse-engineer
the format from scratch again.
"""
import csv
import json
import math
import os
import sys
import urllib.request

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".cache")
OUT_PATH = os.path.join(REPO_ROOT, "frontend", "src", "worldMapData.ts")

NE_BASE = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson"
OURAIRPORTS_BASE = "https://davidmegginson.github.io/ourairports-data"

SOURCES = {
    "countries": f"{NE_BASE}/ne_50m_admin_0_countries.geojson",
    "cities": f"{NE_BASE}/ne_50m_populated_places.geojson",
    "urban_areas": f"{NE_BASE}/ne_50m_urban_areas.geojson",
    "airports": f"{NE_BASE}/ne_10m_airports.geojson",
    "rivers": f"{NE_BASE}/ne_50m_rivers_lake_centerlines.geojson",
    "lakes": f"{NE_BASE}/ne_50m_lakes.geojson",
    "oa_airports": f"{OURAIRPORTS_BASE}/airports.csv",
    "oa_runways": f"{OURAIRPORTS_BASE}/runways.csv",
}

# Filters — the actual "how much detail" knobs. See each site below for why
# this particular value, not a smaller/larger one.
CITY_MIN_POP = 100_000        # OR a national capital regardless of population
AIRPORT_TYPES = {"major", "major and military", "mid", "mid and military", "military mid", "military major"}
URBAN_MATCH_MAX_DEG = 0.35    # same threshold the original generation used
COUNTRY_SIMPLIFY_DEG = 0.045  # ~5km at the equator — real coastline detail, not 1:110m's blob outlines, without countries alone dominating bundle size (0.02 measured ~1.2MB just for this array; this is the size/detail knob to revisit first if more detail is ever worth the weight)
RIVER_SIMPLIFY_DEG = 0.045
LAKE_SIMPLIFY_DEG = 0.02


def fetch(key: str) -> str:
    os.makedirs(CACHE_DIR, exist_ok=True)
    path = os.path.join(CACHE_DIR, key + os.path.splitext(SOURCES[key])[1])
    if os.path.exists(path):
        return path
    print(f"Fetching {key}...", file=sys.stderr)
    with urllib.request.urlopen(SOURCES[key], timeout=120) as resp:
        data = resp.read()
    with open(path, "wb") as f:
        f.write(data)
    return path


def load_geojson(key: str) -> dict:
    with open(fetch(key), encoding="utf-8") as f:
        return json.load(f)


# --- Douglas-Peucker -------------------------------------------------------

def _perp_dist(p, a, b):
    (px, py), (ax, ay), (bx, by) = p, a, b
    dx, dy = bx - ax, by - ay
    if dx == 0 and dy == 0:
        return math.hypot(px - ax, py - ay)
    t = ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)
    cx, cy = ax + t * dx, ay + t * dy
    return math.hypot(px - cx, py - cy)


def simplify(points, epsilon):
    """Standard recursive Douglas-Peucker. Always keeps both endpoints."""
    if len(points) < 3:
        return points
    dmax, index = 0.0, 0
    for i in range(1, len(points) - 1):
        d = _perp_dist(points[i], points[0], points[-1])
        if d > dmax:
            dmax, index = d, i
    if dmax > epsilon:
        left = simplify(points[: index + 1], epsilon)
        right = simplify(points[index:], epsilon)
        return left[:-1] + right
    return [points[0], points[-1]]


# --- Geometry extraction ----------------------------------------------------

def rings_from_geometry(geom, epsilon):
    """Polygon/MultiPolygon -> flat list of simplified [lon, lat] rings
    (every ring — outer boundaries and holes alike — canvas's default
    nonzero fill rule handles holes correctly as long as GeoJSON's
    right-hand-rule winding is intact, which Natural Earth's data is)."""
    rings = []
    if geom["type"] == "Polygon":
        polys = [geom["coordinates"]]
    elif geom["type"] == "MultiPolygon":
        polys = geom["coordinates"]
    else:
        return rings
    for poly in polys:
        for ring in poly:
            pts = [(lon, lat) for lon, lat in ring]
            simplified = simplify(pts, epsilon)
            if len(simplified) >= 3:
                rings.append(simplified)
    return rings


def lines_from_geometry(geom, epsilon):
    """LineString/MultiLineString -> list of simplified [lon, lat] paths."""
    if geom["type"] == "LineString":
        lines = [geom["coordinates"]]
    elif geom["type"] == "MultiLineString":
        lines = geom["coordinates"]
    else:
        return []
    out = []
    for line in lines:
        pts = [(lon, lat) for lon, lat in line]
        simplified = simplify(pts, epsilon)
        if len(simplified) >= 2:
            out.append(simplified)
    return out


def polygon_centroid(geom):
    """Cheap vertex-average centroid (not area-weighted) — good enough for
    nearest-city matching, which only needs "roughly where," not precision."""
    if geom["type"] == "Polygon":
        pts = geom["coordinates"][0]
    elif geom["type"] == "MultiPolygon":
        pts = geom["coordinates"][0][0]
    else:
        return None
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    return (sum(xs) / len(xs), sum(ys) / len(ys))


# --- Per-dataset builders ----------------------------------------------------

def build_countries():
    data = load_geojson("countries")
    out = []
    for f in data["features"]:
        props = f["properties"]
        rings = rings_from_geometry(f["geometry"], COUNTRY_SIMPLIFY_DEG)
        if not rings:
            continue
        label_x, label_y = props.get("LABEL_X"), props.get("LABEL_Y")
        label = [label_x, label_y] if label_x is not None and label_y is not None else None
        out.append({"name": props.get("NAME") or props.get("ADMIN"), "rings": rings, "label": label})
    return out


def build_cities_and_airports_shared_urban(cities_raw):
    data = load_geojson("urban_areas")
    areas = []
    for f in data["features"]:
        c = polygon_centroid(f["geometry"])
        if c is None:
            continue
        rings = rings_from_geometry(f["geometry"], LAKE_SIMPLIFY_DEG)
        if not rings:
            continue
        # Largest ring by vertex count as a cheap stand-in for "the main
        # body" — matches the single-outline-per-city shape CityFeature
        # expects (no holes/multi-part urban sprawl modeling needed here).
        outline = max(rings, key=len)
        areas.append((c, outline))

    matched = []
    for city in cities_raw:
        lon, lat = city["pos"]
        best_d, best_outline = URBAN_MATCH_MAX_DEG, None
        for (clon, clat), outline in areas:
            d = math.hypot(lon - clon, lat - clat)
            if d < best_d:
                best_d, best_outline = d, outline
        entry = dict(city)
        if best_outline is not None:
            entry["outline"] = best_outline
        matched.append(entry)
    return matched


def build_cities():
    data = load_geojson("cities")
    raw = []
    for f in data["features"]:
        props = f["properties"]
        pop = props.get("POP_MAX") or 0
        capital = bool(props.get("ADM0CAP"))
        if pop < CITY_MIN_POP and not capital:
            continue
        lon, lat = props.get("LONGITUDE"), props.get("LATITUDE")
        if lon is None or lat is None:
            continue
        raw.append({"name": props.get("NAME"), "pos": (lon, lat), "pop": int(pop), "capital": capital})
    return build_cities_and_airports_shared_urban(raw)


def build_airports():
    data = load_geojson("airports")
    ne_airports = []
    for f in data["features"]:
        props = f["properties"]
        iata = props.get("iata_code")
        atype = props.get("type")
        if not iata or atype not in AIRPORT_TYPES:
            continue
        lon, lat = f["geometry"]["coordinates"][0], f["geometry"]["coordinates"][1]
        ne_airports.append({"name": props.get("name"), "code": iata, "pos": (lon, lat)})

    # OurAirports join: iata_code -> ident, then ident -> runway endpoints.
    # Only OurAirports carries real runway geometry at all; Natural Earth's
    # own airport points have no runway data to fall back to.
    iata_to_ident = {}
    with open(fetch("oa_airports"), encoding="utf-8") as f:
        for row in csv.DictReader(f):
            iata = row.get("iata_code")
            if iata and iata not in iata_to_ident:
                iata_to_ident[iata] = row["ident"]

    runways_by_ident: dict[str, list] = {}
    with open(fetch("oa_runways"), encoding="utf-8") as f:
        for row in csv.DictReader(f):
            if row.get("closed") == "1":
                continue
            try:
                le = (float(row["le_longitude_deg"]), float(row["le_latitude_deg"]))
                he = (float(row["he_longitude_deg"]), float(row["he_latitude_deg"]))
            except (TypeError, ValueError):
                continue
            runways_by_ident.setdefault(row["airport_ident"], []).append([le, he])

    out = []
    for ap in ne_airports:
        ident = iata_to_ident.get(ap["code"])
        entry = dict(ap)
        if ident and ident in runways_by_ident:
            entry["runways"] = runways_by_ident[ident]
        out.append(entry)
    return out


def build_rivers():
    data = load_geojson("rivers")
    out = []
    for f in data["features"]:
        for path in lines_from_geometry(f["geometry"], RIVER_SIMPLIFY_DEG):
            out.append({"path": path})
    return out


def build_lakes():
    data = load_geojson("lakes")
    out = []
    for f in data["features"]:
        rings = rings_from_geometry(f["geometry"], LAKE_SIMPLIFY_DEG)
        if rings:
            # Largest ring only — drops any inner-hole rings a lake polygon
            # might carry (a lake with an island in it); a rare enough case
            # at this scale that a slightly-simplified fill is a fine trade
            # for keeping LakeFeature's shape a single ring, matching
            # CityFeature.outline's own single-ring convention.
            out.append({"ring": max(rings, key=len)})
    return out


# --- TypeScript codegen ------------------------------------------------------

def fmt_num(n):
    if isinstance(n, float) and n == int(n):
        n = int(n)
    return repr(n)


def fmt_point(p):
    return f"[{fmt_num(p[0])},{fmt_num(p[1])}]"


def fmt_ring(ring):
    return "[" + ",".join(fmt_point(p) for p in ring) + "]"


def fmt_str(s):
    return json.dumps(s or "")


def emit(countries, cities, airports, rivers, lakes):
    parts = []
    parts.append(HEADER)
    parts.append("export interface CountryFeature {\n  name: string;\n  rings: [number, number][][];\n  label: [number, number] | null;\n}")
    parts.append(
        "export interface AirportFeature {\n"
        "  name: string;\n  code: string;\n  pos: [number, number];\n"
        "  /** Real runway centerlines (each a [start, end] pair, lon/lat) — see file header. Absent for a handful of airports with no matching runway data. */\n"
        "  runways?: [number, number][][];\n}"
    )
    parts.append(
        "export interface CityFeature {\n"
        "  name: string;\n  pos: [number, number];\n  pop: number;\n  capital: boolean;\n"
        "  /** Simplified urban-area boundary ring (lon/lat) — see file header. Absent below Natural Earth's urban-area threshold or with no close-enough match; falls back to a dot. */\n"
        "  outline?: [number, number][];\n}"
    )
    parts.append(
        "/** One simplified river centerline (lon/lat), Natural Earth's rivers_lake_centerlines layer. */\n"
        "export interface RiverFeature {\n  path: [number, number][];\n}"
    )
    parts.append(
        "/** One lake's outer boundary ring (lon/lat) — inner islands/holes dropped, see file header. */\n"
        "export interface LakeFeature {\n  ring: [number, number][];\n}"
    )

    def country_lit(c):
        label = "null" if c["label"] is None else fmt_point(c["label"])
        rings = "[" + ",".join(fmt_ring(r) for r in c["rings"]) + "]"
        return f'{{"name":{fmt_str(c["name"])},"rings":{rings},"label":{label}}}'

    def city_lit(c):
        base = f'{{"name":{fmt_str(c["name"])},"pos":{fmt_point(c["pos"])},"pop":{c["pop"]},"capital":{"true" if c["capital"] else "false"}'
        if "outline" in c:
            base += f',"outline":{fmt_ring(c["outline"])}'
        return base + "}"

    def airport_lit(a):
        base = f'{{"name":{fmt_str(a["name"])},"code":{fmt_str(a["code"])},"pos":{fmt_point(a["pos"])}'
        if "runways" in a:
            segs = "[" + ",".join(fmt_ring(seg) for seg in a["runways"]) + "]"
            base += f',"runways":{segs}'
        return base + "}"

    def river_lit(r):
        return f'{{"path":{fmt_ring(r["path"])}}}'

    def lake_lit(lk):
        return f'{{"ring":{fmt_ring(lk["ring"])}}}'

    # Raw export names match the existing convention (COUNTRIES/CITIES/
    # AIRPORTS, no WORLD_ prefix) — VectorBasemap.tsx derives its own
    # module-local WORLD_* pre-projected versions from these at load time
    # (see its own COUNTRIES.map(...)/CITIES.map(...)/AIRPORTS.map(...)).
    parts.append("export const COUNTRIES: CountryFeature[] = [" + ",".join(country_lit(c) for c in countries) + "];")
    parts.append("export const CITIES: CityFeature[] = [" + ",".join(city_lit(c) for c in cities) + "];")
    parts.append("export const AIRPORTS: AirportFeature[] = [" + ",".join(airport_lit(a) for a in airports) + "];")
    parts.append("export const RIVERS: RiverFeature[] = [" + ",".join(river_lit(r) for r in rivers) + "];")
    parts.append("export const LAKES: LakeFeature[] = [" + ",".join(lake_lit(lk) for lk in lakes) + "];")
    return "\n\n".join(parts) + "\n"


HEADER = """// GENERATED FILE — see scripts/generate_world_map_data.py, run from the
// repo root, to regenerate. Do not hand-edit; change the thresholds/
// sources in that script instead.
//
// Sources: Natural Earth 1:50m admin-0 countries, populated places, urban
// areas, rivers_lake_centerlines, and lakes; Natural Earth 1:10m airports
// (the only tier with airport points at all); OurAirports' open
// airports.csv + runways.csv, joined onto the Natural Earth airports by
// IATA code for real runway centerlines. Raw lon/lat throughout, not
// pre-projected: this data is projected live through Leaflet's own
// latLngToContainerPoint, same as every marker already is, so it stays
// correct at any pan/zoom instead of being baked in for one fixed view
// (see VectorBasemap.tsx).
//
// City outlines and airport runways are matched/joined the same way as
// the original (pre-regeneration) version of this file: a city's outline
// is the nearest urban-area polygon within ~0.35 degrees (not every city
// has a close-enough match at this scale); an airport's runways come from
// OurAirports via its IATA code (not every airport OurAirports carries a
// matching ident for)."""


def main():
    countries = build_countries()
    cities = build_cities()
    airports = build_airports()
    rivers = build_rivers()
    lakes = build_lakes()

    print(
        f"countries={len(countries)} cities={len(cities)} "
        f"(with outline={sum(1 for c in cities if 'outline' in c)}) "
        f"airports={len(airports)} (with runways={sum(1 for a in airports if 'runways' in a)}) "
        f"rivers={len(rivers)} lakes={len(lakes)}",
        file=sys.stderr,
    )

    ts = emit(countries, cities, airports, rivers, lakes)
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        f.write(ts)
    print(f"Wrote {OUT_PATH} ({len(ts)} bytes)", file=sys.stderr)


if __name__ == "__main__":
    main()
