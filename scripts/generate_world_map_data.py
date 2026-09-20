#!/usr/bin/env python3
"""Regenerates frontend/src/worldMapData.ts from Natural Earth airport data.
Pure stdlib (json/urllib) — no GIS libraries needed for what this does.

Run from the repo root: python3 scripts/generate_world_map_data.py

This script used to build the entire cyberpunk basemap: country outlines,
populated places joined to urban-area polygons, river centerlines, lakes,
and airport runways joined from OurAirports by IATA code — ~4.2MB of
embedded geometry (1.6MB gzipped), by a wide margin the largest asset in
the app. All of it existed because that theme drew the world itself onto a
canvas from bundled data.

It doesn't any more. The map renders OpenStreetMap vector tiles through a
style of our own (frontend/src/cyberpunkMapStyle.ts), which carries
coastlines, borders, water, landuse, roads, buildings and full airport
layouts at every zoom — everything the bundled data had, plus everything it
structurally couldn't (Natural Earth 1:10m tops out around zoom 7-8; the
app zooms to 18). Runways included, so the OurAirports join went too.

What survives is the airport *list*: name, IATA code and position for every
major airport, which the app renders as real Leaflet markers on both themes
(see DefaultAirports.tsx) because they're clickable — they open the airport
dossier — and a marker the app owns is easier to hit-test, style and stack
above aircraft than a symbol baked into a tile. ~160KB, down from 4.2MB.

Source: Natural Earth 1:10m airports, via the nvkelso/natural-earth-vector
GeoJSON mirror (Natural Earth's own site has no stable direct-download URLs
for individual layers). 1:10m is required — 1:50m carries no airport layer
at all. Cached under scripts/.cache/ so re-runs while tuning don't
re-download; delete that directory to force a refresh.
"""
import json
import os
import sys
import urllib.request

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".cache")
OUT_PATH = os.path.join(REPO_ROOT, "frontend", "src", "worldMapData.ts")

NE_BASE = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson"

SOURCES = {
    "airports": f"{NE_BASE}/ne_10m_airports.geojson",
}

# The "how much detail" knob. Natural Earth classifies airports by
# significance; this keeps the major/mid tiers (with their military
# variants) and drops small regional strips, which at world scale are
# noise. Airports without an IATA code are skipped regardless — the code is
# both the label drawn on the map and the key /api/airports/info is looked
# up by.
AIRPORT_TYPES = {"major", "major and military", "mid", "mid and military", "military mid", "military major"}

# Natural Earth's own "how far out should this still be drawn" ranking:
# lower means more significant, and the value is the smallest scale (most
# zoomed-out map) the cartographers think the airport earns a place on.
# Carried through to the app so it can thin the list as you zoom out
# instead of drawing all of them at every zoom — 878 markers over a whole
# continent is unreadable. The zoom thresholds themselves live in
# DefaultAirports.tsx, not here: they're a display decision worth tuning
# without regenerating this file.
#
# Distribution across the airports kept above, for a sense of scale:
#   rank 2: 65   3: 25   4: 194   5: 46   6: 150   7: 132   8: 238   9: 28
DEFAULT_SCALERANK = 9  # treat a missing rank as least significant


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


def build_airports():
    data = load_geojson("airports")
    out = []
    for f in data["features"]:
        props = f["properties"]
        iata = props.get("iata_code")
        if not iata or props.get("type") not in AIRPORT_TYPES:
            continue
        lon, lat = f["geometry"]["coordinates"][0], f["geometry"]["coordinates"][1]
        rank = props.get("scalerank")
        if not isinstance(rank, int):
            rank = DEFAULT_SCALERANK
        out.append({"name": props.get("name"), "code": iata, "pos": (lon, lat), "rank": rank})
    # Most significant first. Nothing depends on the order for correctness,
    # but it means a truncated or partially-rendered list still shows the
    # airports that matter most.
    out.sort(key=lambda a: (a["rank"], a["code"]))
    return out


def fmt_num(n):
    # Trims float noise without visibly moving anything: 6 decimal places is
    # ~11cm at the equator, far below what a dot on a map can express.
    s = f"{round(n, 6):.6f}".rstrip("0").rstrip(".")
    return s if s else "0"


def fmt_point(p):
    return f"[{fmt_num(p[0])},{fmt_num(p[1])}]"


def fmt_str(s):
    return json.dumps(s or "", ensure_ascii=False)


def emit(airports):
    lines = [
        "// GENERATED FILE — see scripts/generate_world_map_data.py, run from the",
        "// repo root, to regenerate. Do not hand-edit; change the filter in that",
        "// script instead.",
        "//",
        "// Source: Natural Earth 1:10m airports (the only tier carrying an airport",
        "// layer at all), filtered to the major/mid significance tiers. Each keeps",
        "// Natural Earth's scalerank so the app can thin them out as you zoom out.",
        "// Raw lon/lat,",
        "// not pre-projected: these are rendered as real Leaflet markers (see",
        "// DefaultAirports.tsx) and projected live like every other marker, so they",
        "// stay correct at any pan/zoom.",
        "//",
        "// This file used to carry country outlines, cities, rivers and lakes as",
        "// well — ~4.2MB of geometry the old canvas basemap drew by hand. All of",
        "// that comes from vector tiles now (see cyberpunkMapStyle.ts); only the",
        "// airport list is still bundled, because these markers are clickable and",
        "// the app wants to own their hit-testing and stacking.",
        "",
        "export interface AirportFeature {",
        "  name: string;",
        "  code: string;",
        "  pos: [number, number];",
        "  /**",
        "   * Natural Earth's scalerank: lower is more significant. Drives which",
        "   * airports survive at which zoom — see MAX_RANK_BY_ZOOM in",
        "   * DefaultAirports.tsx. Sorted most-significant-first below.",
        "   */",
        "  rank: number;",
        "}",
        "",
    ]
    entries = [
        "{"
        + f'"name":{fmt_str(a["name"])},"code":{fmt_str(a["code"])},'
        + f'"pos":{fmt_point(a["pos"])},"rank":{a["rank"]}'
        + "}"
        for a in airports
    ]
    lines.append("export const AIRPORTS: AirportFeature[] = [" + ",".join(entries) + "];")
    lines.append("")
    return "\n".join(lines)


def main():
    airports = build_airports()
    print(f"airports={len(airports)}", file=sys.stderr)
    ts = emit(airports)
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        f.write(ts)
    print(f"Wrote {OUT_PATH} ({len(ts)} bytes)", file=sys.stderr)


if __name__ == "__main__":
    main()
