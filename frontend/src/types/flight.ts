/** A lat/lon bounding box — the current map viewport. */
export interface Bounds {
  latMin: number;
  latMax: number;
  lonMin: number;
  lonMax: number;
}

export interface FlightPosition {
  id: number;
  icao24: string;
  callsign: string | null;
  observedAt: string; // ISO instant
  latitude: number;
  longitude: number;
  altitudeM: number | null;
  velocityMs: number | null;
  headingDeg: number | null;
  verticalRateMs: number | null;
  onGround: boolean;
  agentSource: string;
}

/** One server-aggregated grid cell — a zoomed-way-out summary of live traffic. */
export interface ClusterPoint {
  lat: number;
  lon: number;
  count: number;
}

export interface AircraftDossier {
  icao24: string;
  registration: string | null;
  model: string | null;
  operator: string | null;
  originAirport: string | null;
  originAirportName: string | null;
  originAirportIata: string | null;
  destinationAirport: string | null;
  destinationAirportName: string | null;
  destinationAirportIata: string | null;
  // All computed server-side from live/historic position data, not stored
  // — see AircraftDossier.java's javadoc for exactly when each is null.
  flightMinutes: number | null;
  etaMinutes: number | null;
  cruisingAltitudeM: number | null;
  /** "ON_GROUND" | "TAKING_OFF" | "CLIMBING" | "LEVEL" | "DESCENDING" | "LANDING" */
  flightPhase: string | null;
  /** Human-readable guess at what a since-gone-quiet aircraft is doing — only meaningful once the frontend's own staleness check says to show it. */
  staleExplanation: string | null;
  /** ISO instant this leg took off, or null with no airborne history for it at all — see FlightMap.tsx's trail-trimming use. */
  legStartAt: string | null;
}

export interface PollingStatus {
  active: boolean;
  secondsRemaining: number;
}

export interface AircraftUsage {
  icao24: string;
  registration: string | null;
  positionReports: number;
  distanceFlownKm: number;
  airborneHours: number;
  averageGroundSpeedKmh: number;
}
