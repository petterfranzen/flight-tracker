#!/usr/bin/env python3
"""Builds backend/src/main/resources/runways.tsv from OurAirports runways.csv.

OurAirports data is public domain (https://ourairports.com/data/). To
regenerate (needs Python 3, stdlib only):

    curl -sSL -o /tmp/runways.csv \
        https://davidmegginson.github.io/ourairports-data/runways.csv
    python3 scripts/build-runways-tsv.py /tmp/runways.csv \
        backend/src/main/resources/airports.tsv \
        backend/src/main/resources/runways.tsv

Output: one line per landing direction (a physical runway gives two).
Columns: airport_icao ident threshold_lat threshold_lon heading_deg
elevation_m length_m. Tab-delimited, header line first, like airports.tsv.

Filters: airport_ident must be an icao_code in airports.tsv, the runway
must not be closed and must have lat/lon at both ends, and runways shorter
than MIN_LENGTH_M are dropped (they matter little for airliners).

Per direction:
- heading_deg is the true heading from the CSV, or the initial great-circle
  bearing to the opposite end when the CSV has none (or an impossible one).
- The threshold is moved along the heading by the displaced threshold
  (feet, if given), and length_m is the landing length from that point:
  runway length minus that displacement.
- elevation_m is the end's own elevation, else the opposite end's, else empty.
"""
import csv
import math
import sys

MIN_LENGTH_M = 600.0
FT = 0.3048
R_EARTH_M = 6371008.8


def bearing(lat1, lon1, lat2, lon2):
    p1, p2, dl = math.radians(lat1), math.radians(lat2), math.radians(lon2 - lon1)
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return math.degrees(math.atan2(y, x)) % 360.0


def move(lat, lon, heading, dist_m):
    p1, l1, th, d = math.radians(lat), math.radians(lon), math.radians(heading), dist_m / R_EARTH_M
    p2 = math.asin(math.sin(p1) * math.cos(d) + math.cos(p1) * math.sin(d) * math.cos(th))
    l2 = l1 + math.atan2(math.sin(th) * math.sin(d) * math.cos(p1),
                         math.cos(d) - math.sin(p1) * math.sin(p2))
    return math.degrees(p2), (math.degrees(l2) + 540.0) % 360.0 - 180.0


def num(s):
    try:
        return float(s) if s.strip() else None
    except ValueError:
        return None


def direction(row, own, other, length_ft):
    lat, lon = num(row[own + "_latitude_deg"]), num(row[own + "_longitude_deg"])
    olat, olon = num(row[other + "_latitude_deg"]), num(row[other + "_longitude_deg"])
    heading = num(row[own + "_heading_degT"])
    if heading is None or not 0.0 <= heading <= 360.0:
        heading = bearing(lat, lon, olat, olon)
    heading %= 360.0
    displaced_ft = num(row[own + "_displaced_threshold_ft"]) or 0.0
    if displaced_ft > 0:
        lat, lon = move(lat, lon, heading, displaced_ft * FT)
    elev_ft = num(row[own + "_elevation_ft"])
    if elev_ft is None:
        elev_ft = num(row[other + "_elevation_ft"])
    elev = "" if elev_ft is None else "%d" % round(elev_ft * FT)
    length_m = max(0.0, (length_ft - displaced_ft) * FT)
    return [row["airport_ident"], row[own + "_ident"].strip(), "%.6f" % lat, "%.6f" % lon,
            "%.1f" % heading, elev, "%d" % round(length_m)]


def main(runways_csv, airports_tsv, out_tsv):
    with open(airports_tsv, encoding="utf-8") as f:
        airports = {line.split("\t", 1)[0] for line in f.read().splitlines()[1:] if line}
    out = {}
    with open(runways_csv, encoding="utf-8", newline="") as f:
        for row in csv.DictReader(f):
            if row["airport_ident"] not in airports or row["closed"] == "1":
                continue
            if any(num(row[k]) is None for k in (
                    "le_latitude_deg", "le_longitude_deg", "he_latitude_deg", "he_longitude_deg")):
                continue
            if not row["le_ident"].strip() or not row["he_ident"].strip():
                continue
            length_ft = num(row["length_ft"])
            if length_ft is None or length_ft * FT < MIN_LENGTH_M:
                continue
            for own, other in (("le", "he"), ("he", "le")):
                d = direction(row, own, other, length_ft)
                key = (d[0], d[1])
                if key not in out or int(d[6]) > int(out[key][6]):   # (icao, ident) is the key
                    out[key] = d
    with open(out_tsv, "w", encoding="utf-8", newline="\n") as f:
        f.write("airport_icao\tident\tthreshold_lat\tthreshold_lon\theading_deg\televation_m\tlength_m\n")
        for key in sorted(out):
            f.write("\t".join(out[key]) + "\n")
    print("wrote %d directions at %d airports to %s" % (len(out), len({k[0] for k in out}), out_tsv))


if __name__ == "__main__":
    if len(sys.argv) != 4:
        sys.exit(__doc__)
    main(*sys.argv[1:])
