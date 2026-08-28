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

export interface AircraftDossier {
  icao24: string;
  registration: string | null;
  model: string | null;
  operator: string | null;
  originAirport: string | null;
  originAirportName: string | null;
  destinationAirport: string | null;
  destinationAirportName: string | null;
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
