/**
 * A small simulated world for the user-journey scenarios: ~230 aircraft
 * around Arlanda, Schiphol and Kalmar, each flying a straight line at a
 * constant speed in real time, with a route (origin/destination), a
 * history and a dossier. Deterministic (seeded) so every run has the same
 * aircraft in the same places relative to the start of the test.
 *
 * Truth is time-based: positionAt(a, now) is where the aircraft really is.
 * The mocked API always serves the position at the moment of the request,
 * like the real backend does after a poll, so any marker the app draws can
 * be checked against where the aircraft actually is right now.
 */

export interface Airport {
  icao: string;
  iata: string;
  name: string;
  city: string;
  lat: number;
  lon: number;
}

export const AIRPORTS: Airport[] = [
  { icao: "ESSA", iata: "ARN", name: "Stockholm-Arlanda Airport", city: "Stockholm", lat: 59.6519, lon: 17.9186 },
  { icao: "ESSB", iata: "BMA", name: "Stockholm-Bromma Airport", city: "Stockholm", lat: 59.3544, lon: 17.9417 },
  { icao: "ESMQ", iata: "KLR", name: "Kalmar Airport", city: "Kalmar", lat: 56.6855, lon: 16.2876 },
  { icao: "ESGG", iata: "GOT", name: "Göteborg Landvetter Airport", city: "Gothenburg", lat: 57.6628, lon: 12.2798 },
  { icao: "EKCH", iata: "CPH", name: "Copenhagen Kastrup Airport", city: "Copenhagen", lat: 55.6181, lon: 12.656 },
  { icao: "EHAM", iata: "AMS", name: "Amsterdam Airport Schiphol", city: "Amsterdam", lat: 52.3086, lon: 4.7639 },
  { icao: "EGLL", iata: "LHR", name: "London Heathrow Airport", city: "London", lat: 51.47, lon: -0.4543 },
];
const byIcao = new Map(AIRPORTS.map((a) => [a.icao, a]));

export interface SimAircraft {
  icao24: string;
  callsign: string;
  origin: string; // ICAO
  destination: string; // ICAO
  lat0: number;
  lon0: number;
  headingDeg: number;
  altitudeM: number;
}

/** Degrees per second along the heading: ~250 m/s, a cruising airliner. */
export const SPEED_DEG_PER_S = 0.0022;
/** History the dossier/route shows: the last 40 minutes, one point a minute. */
const HISTORY_S = 40 * 60;

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

export class World {
  readonly t0 = Date.now();
  readonly aircraft: SimAircraft[] = [];
  private readonly byId = new Map<string, SimAircraft>();

  constructor() {
    const r = rng(42);
    const groups: { n: number; lat: number; lon: number; spread: number; prefix: string; routes: [string, string][] }[] = [
      { n: 140, lat: 59.65, lon: 17.92, spread: 1.4, prefix: "SAS", routes: [["ESSA", "EHAM"], ["ESSA", "EGLL"], ["ESGG", "ESSA"], ["ESSA", "EKCH"]] },
      { n: 70, lat: 52.31, lon: 4.76, spread: 1.2, prefix: "KLM", routes: [["EHAM", "ESSA"], ["EGLL", "EHAM"], ["EHAM", "EKCH"]] },
      { n: 12, lat: 57.4, lon: 16.8, spread: 1.0, prefix: "BRX", routes: [["ESSB", "ESMQ"], ["ESMQ", "ESSB"], ["ESMQ", "ESSA"]] },
      { n: 10, lat: 58.5, lon: 15.0, spread: 2.0, prefix: "NOZ", routes: [["ESSA", "ESGG"], ["EKCH", "ESSA"]] },
    ];
    let id = 0x4a0000;
    for (const g of groups) {
      for (let i = 0; i < g.n; i++) {
        const [origin, destination] = g.routes[i % g.routes.length];
        const a: SimAircraft = {
          icao24: (id++).toString(16),
          callsign: `${g.prefix}${String(100 + i).padStart(3, "0")}`,
          origin,
          destination,
          lat0: g.lat + (r() - 0.5) * 2 * g.spread,
          lon0: g.lon + (r() - 0.5) * 2 * g.spread * 1.8,
          headingDeg: Math.floor(r() * 360),
          altitudeM: Math.floor(3000 + r() * 8000),
        };
        this.aircraft.push(a);
        this.byId.set(a.icao24, a);
      }
    }
  }

  get(icao24: string): SimAircraft | undefined {
    return this.byId.get(icao24);
  }

  byCallsign(callsign: string): SimAircraft | undefined {
    return this.aircraft.find((a) => a.callsign === callsign);
  }

  /** Where the aircraft truly is at wall-clock time `atMs`. */
  positionAt(a: SimAircraft, atMs = Date.now()): { lat: number; lon: number } {
    const t = (atMs - this.t0) / 1000;
    const h = (a.headingDeg * Math.PI) / 180;
    return { lat: a.lat0 + Math.cos(h) * SPEED_DEG_PER_S * t, lon: a.lon0 + Math.sin(h) * SPEED_DEG_PER_S * t };
  }

  /** The API's FlightPosition for `a` at `atMs`. */
  flightPosition(a: SimAircraft, atMs = Date.now()) {
    const p = this.positionAt(a, atMs);
    return {
      id: 0,
      icao24: a.icao24,
      callsign: a.callsign,
      observedAt: new Date(atMs).toISOString(),
      latitude: p.lat,
      longitude: p.lon,
      altitudeM: a.altitudeM,
      velocityMs: 245,
      headingDeg: a.headingDeg,
      verticalRateMs: 0,
      onGround: false,
      agentSource: "opensky",
    };
  }

  inBounds(a: SimAircraft, b: { latMin: number; latMax: number; lonMin: number; lonMax: number }, atMs = Date.now()): boolean {
    const p = this.positionAt(a, atMs);
    return p.lat >= b.latMin && p.lat <= b.latMax && p.lon >= b.lonMin && p.lon <= b.lonMax;
  }

  history(a: SimAircraft, nowMs = Date.now()) {
    const out = [];
    for (let s = HISTORY_S; s >= 0; s -= 60) out.push(this.flightPosition(a, nowMs - s * 1000));
    return out;
  }

  dossier(a: SimAircraft, nowMs = Date.now()) {
    const o = byIcao.get(a.origin)!;
    const d = byIcao.get(a.destination)!;
    return {
      icao24: a.icao24,
      registration: `SE-${a.icao24.slice(-3).toUpperCase()}`,
      model: "Airbus A320neo",
      operator: a.callsign.slice(0, 3),
      originAirport: o.icao,
      originAirportName: o.name,
      originAirportIata: o.iata,
      destinationAirport: d.icao,
      destinationAirportName: d.name,
      destinationAirportIata: d.iata,
      flightMinutes: HISTORY_S / 60,
      etaMinutes: 35,
      cruisingAltitudeM: a.altitudeM,
      flightPhase: "CRUISE",
      staleExplanation: null,
      legStartAt: new Date(nowMs - HISTORY_S * 1000).toISOString(),
    };
  }

  /** Mirrors FlightController.search's airport mode: codes/name/city, then routes. */
  searchByAirport(text: string): SimAircraft[] {
    const needle = text.toLowerCase();
    const codes = new Set(
      AIRPORTS.filter((ap) => [ap.icao, ap.iata, ap.name, ap.city].some((v) => v.toLowerCase().includes(needle))).map((ap) => ap.icao),
    );
    return this.aircraft.filter((a) => codes.has(a.origin) || codes.has(a.destination));
  }

  airportInfo(code: string) {
    const ap = AIRPORTS.find((x) => x.iata === code || x.icao === code);
    return ap
      ? { icaoCode: ap.icao, iataCode: ap.iata, name: ap.name, municipality: ap.city, country: "SE", latitude: ap.lat, longitude: ap.lon }
      : null;
  }
}
