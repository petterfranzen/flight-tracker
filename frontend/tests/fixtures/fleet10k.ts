/**
 * Deterministic 10,000-aircraft fleet for perf.spec.ts — roughly the size
 * of OpenSky's real worldwide live set, generated rather than checked in
 * (a captured 10k-row /live response is ~3 MB of JSON). Seeded PRNG, so
 * every run, and every machine, sees exactly the same fleet.
 *
 * The distribution is deliberately lumpy the way real traffic is: dense
 * over Europe and the US, a hot spot around London (where the perf test
 * zooms in, so a z8+ viewport genuinely has hundreds of aircraft in it),
 * and a thin scatter everywhere else.
 */
export interface FleetAircraft {
  icao24: string;
  callsign: string;
  latitude: number;
  longitude: number;
  headingDeg: number;
  altitudeM: number;
  velocityMs: number;
}

export const FLEET_SIZE = 10_000;

// mulberry32 — tiny, fast, good enough for test data.
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Region {
  share: number;
  latMin: number;
  latMax: number;
  lonMin: number;
  lonMax: number;
}

const REGIONS: Region[] = [
  { share: 0.12, latMin: 50.0, latMax: 53.0, lonMin: -2.5, lonMax: 1.5 }, // London hot spot
  { share: 0.28, latMin: 36.0, latMax: 62.0, lonMin: -10.0, lonMax: 30.0 }, // Europe
  { share: 0.3, latMin: 25.0, latMax: 49.0, lonMin: -125.0, lonMax: -67.0 }, // contiguous US
  { share: 0.1, latMin: 20.0, latMax: 45.0, lonMin: 100.0, lonMax: 145.0 }, // East Asia
  { share: 0.2, latMin: -60.0, latMax: 75.0, lonMin: -180.0, lonMax: 180.0 }, // everywhere else
];

let cached: FleetAircraft[] | null = null;

export function fleet10k(): FleetAircraft[] {
  if (cached) return cached;
  const r = rng(0xf1197);
  const out: FleetAircraft[] = [];
  let regionIndex = 0;
  let regionLeft = Math.round(REGIONS[0].share * FLEET_SIZE);
  for (let i = 0; i < FLEET_SIZE; i++) {
    while (regionLeft <= 0 && regionIndex < REGIONS.length - 1) {
      regionIndex++;
      regionLeft = Math.round(REGIONS[regionIndex].share * FLEET_SIZE);
    }
    regionLeft--;
    const reg = REGIONS[regionIndex];
    out.push({
      icao24: (0x100000 + i).toString(16),
      callsign: `PRF${String(i).padStart(4, "0")}`,
      latitude: +(reg.latMin + r() * (reg.latMax - reg.latMin)).toFixed(4),
      longitude: +(reg.lonMin + r() * (reg.lonMax - reg.lonMin)).toFixed(4),
      headingDeg: Math.floor(r() * 360),
      altitudeM: Math.floor(1000 + r() * 11000),
      velocityMs: Math.floor(120 + r() * 140),
    });
  }
  cached = out;
  return out;
}
