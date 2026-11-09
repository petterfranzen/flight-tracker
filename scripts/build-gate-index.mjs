#!/usr/bin/env node
// Build-time OpenStreetMap airport layout index for flight-tracker.
//
// Source: OSM `aeroway=gate` nodes and `aeroway=parking_position` objects
// (remote and cargo stands), via the Overpass API. The gate/stand `ref` and its
// coordinate live only in OSM — every provider we read (Swedavia, AeroDataBox,
// Avinor, Schiphol) returns the gate as text, never a lat/lon.
//
// Data © OpenStreetMap contributors, licensed ODbL 1.0
// (https://www.openstreetmap.org/copyright). The generated file
// frontend/src/map/gateIndexData.ts is a Derivative Database of OSM and is
// covered by the same licence; the app already credits OSM on the map.
//
// Why: OpenFreeMap's basemap ships `aeroway=gate` points only in the zoom-14
// tiles (OpenMapTiles emits the layer from z14), so the runtime tile lookup in
// map.ts finds nothing below app zoom 15 (app zoom = MapLibre zoom + 1). This
// static index works at any zoom and needs no tile to be loaded.
//
// Run from the repository root:
//
//     node scripts/build-gate-index.mjs
//
// Commit the result. Gate and stand moves are rare; re-run to refresh the
// snapshot (Overpass is fair-use: one query per airport, retried with backoff).

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// The airports we carry layouts for: the eight surveyed in section9-hq #195 —
// ARN plus the European hubs the app sees most. The generator takes a list, so
// adding an airport is one line (ICAO + a centre inside the terminal area).
const AIRPORTS = [
  { icao: "ESSA", name: "Stockholm Arlanda", lat: 59.6519, lon: 17.9186 },
  { icao: "ESGG", name: "Gothenburg Landvetter", lat: 57.6628, lon: 12.2798 },
  { icao: "EKCH", name: "Copenhagen", lat: 55.618, lon: 12.6508 },
  { icao: "ENGM", name: "Oslo Gardermoen", lat: 60.1939, lon: 11.1004 },
  { icao: "EFHK", name: "Helsinki-Vantaa", lat: 60.3172, lon: 24.9633 },
  { icao: "EGLL", name: "London Heathrow", lat: 51.47, lon: -0.4543 },
  { icao: "EDDF", name: "Frankfurt", lat: 50.0379, lon: 8.5622 },
  { icao: "EHAM", name: "Amsterdam Schiphol", lat: 52.3105, lon: 4.7683 },
];

// A ring this wide around the centre covers every pier and remote stand of
// these airports.
const RADIUS_M = 6000;

// Tried in order. The French instance is fast and reliable; overpass-api.de is
// the canonical host but sheds load with a 502. A mirror (overpass.osm.ch) has
// answered with an empty element set for a query the main one answers with 58
// nodes, so MIN_GATES below catches a short answer instead of committing it.
const ENDPOINTS = [
  "https://overpass.openstreetmap.fr/api/interpreter",
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];
const ATTEMPTS = 5;
const TIMEOUT_MS = 45_000;
// Every served airport has at least 15 gate nodes; fewer than this means the
// query hit a broken or rate-limited instance, not a real answer.
const MIN_GATES = 5;

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "frontend", "src", "map", "gateIndexData.ts");

// One OSM ref can name several gates/stands ("D1;D101", "A54/A56",
// "C15/C15A+C15B"). Split it, then normalise each part the same way the runtime
// lookup does: upper-case, drop a leading "GATE" word, drop all whitespace. So
// the provider refs "D18", "d18" and "Gate D18" all land on the key "D18". A
// pure range ("59 A-B") carries no separator and is kept whole, so it will not
// match a single provider ref: those are absent from the index on purpose.
const SEPARATORS = /[;,/+()]/;

function normaliseRef(ref) {
  return String(ref)
    .split(SEPARATORS)
    .map((part) => part.trim().toUpperCase().replace(/^GATE\b/, "").replace(/\s+/g, ""))
    .filter(Boolean);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function overpass(query) {
  let lastErr;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    for (const endpoint of ENDPOINTS) {
      try {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": "flight-tracker-gate-index/1.0 (build script; https://github.com/petterfranzen/flight-tracker)",
          },
          body: new URLSearchParams({ data: query }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`); // 502: the public instance is at capacity; retry
        const json = await res.json();
        if (!Array.isArray(json.elements)) throw new Error(`unexpected response shape from ${endpoint}`);
        return json;
      } catch (err) {
        lastErr = err;
      }
    }
    await sleep(4_000 * (attempt + 1)); // back off: the public instance sheds load by queue
  }
  throw lastErr;
}

const rounded = (n) => Math.round(n * 1e5) / 1e5;

// The exact query, kept here so the generated file can record it.
function queryFor(airport) {
  return `[out:json][timeout:90];(node["aeroway"="gate"](around:${RADIUS_M},${airport.lat},${airport.lon});nwr["aeroway"="parking_position"](around:${RADIUS_M},${airport.lat},${airport.lon}););out center;`;
}

async function layoutFor(airport) {
  const data = await overpass(queryFor(airport));
  const gates = new Map();
  const stands = new Map();
  let gateNodes = 0;
  let standObjects = 0;
  let composite = 0;
  for (const el of data.elements ?? []) {
    const kind = el.tags?.aeroway;
    if (kind !== "gate" && kind !== "parking_position") continue;
    // Nodes carry lat/lon; ways and relations carry a centre (`out center`).
    const lat = typeof el.lat === "number" ? el.lat : el.center?.lat;
    const lon = typeof el.lon === "number" ? el.lon : el.center?.lon;
    if (typeof lat !== "number" || typeof lon !== "number") continue;
    if (kind === "gate") gateNodes++;
    else standObjects++;
    const raw = el.tags?.ref;
    if (!raw) continue;
    const parts = normaliseRef(raw);
    if (parts.length > 1) composite++;
    const coord = [rounded(lon), rounded(lat)];
    const target = kind === "gate" ? gates : stands;
    for (const key of parts) if (!target.has(key)) target.set(key, coord); // stable: elements come in id order
  }
  return { gates, stands, gateNodes, standObjects, composite };
}

const sortedObject = (map) => {
  const out = {};
  for (const key of [...map.keys()].sort()) out[key] = map.get(key);
  return out;
};

async function main() {
  const index = {};
  const report = [];
  for (const airport of AIRPORTS) {
    process.stdout.write(`${airport.icao} ${airport.name} ... `);
    const { gates, stands, gateNodes, standObjects, composite } = await layoutFor(airport);
    process.stdout.write(`${gates.size} gates, ${stands.size} stands\n`);
    index[airport.icao] = { gates: sortedObject(gates), stands: sortedObject(stands) };
    report.push(
      `${airport.icao} ${airport.name}: ${gates.size} gate refs (${gateNodes} gate nodes), ` +
        `${stands.size} stand refs (${standObjects} parking_position objects), ${composite} composite`,
    );
  }

  const thin = AIRPORTS.filter((a) => Object.keys(index[a.icao].gates).length < MIN_GATES);
  if (thin.length) {
    console.log(report.join("\n"));
    throw new Error(`too few gates for: ${thin.map((a) => `${a.icao} (${Object.keys(index[a.icao].gates).length})`).join(", ")} — an instance answered short; re-run`);
  }

  const fetched = new Date().toISOString().slice(0, 10);
  const header = `// GENERATED FILE — do not hand-edit. Regenerate with
//     node scripts/build-gate-index.mjs
// from the repository root.
//
// Source: OpenStreetMap, via the Overpass API, fetched ${fetched}.
// Data © OpenStreetMap contributors, ODbL 1.0
// (https://www.openstreetmap.org/copyright). This file is a Derivative
// Database of OSM and is covered by the same licence; the app already credits
// OSM on the map.
//
// Query, per airport (R = ${RADIUS_M} m around the airport centre):
//   [out:json][timeout:90];
//   (node["aeroway"="gate"](around:R,LAT,LON);
//    nwr["aeroway"="parking_position"](around:R,LAT,LON););
//   out center;
//
// \`gates\` are aeroway=gate nodes; \`stands\` are aeroway=parking_position nodes
// and areas (their centre). Both are ref -> [lon, lat], refs normalised the
// same way the runtime lookup does (upper-case, a leading GATE dropped, no
// spaces). The basemap ships gate points only from tile zoom 14 up, so this
// static index is what places a confirmed gate below app zoom 15.

export interface AirportLayout {
  gates: Record<string, [number, number]>;
  stands: Record<string, [number, number]>;
}

export type GateIndex = Record<string, AirportLayout>;

`;

  // One airport per line: small, and a readable diff when a gate moves.
  const lines = Object.entries(index).map(([icao, layout]) => `${JSON.stringify(icao)}:${JSON.stringify(layout)}`);
  JSON.parse(`{${lines.join(",")}}`); // never write a file the app cannot parse
  const body = `${header}export const GATE_INDEX: GateIndex = {\n${lines.join(",\n")}\n};\n`;
  writeFileSync(OUT, body);

  console.log(report.join("\n"));
  console.log(`\nWrote ${OUT} (${Buffer.byteLength(body)} bytes)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
