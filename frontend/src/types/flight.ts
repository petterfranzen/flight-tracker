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

export interface AircraftUsage {
  icao24: string;
  registration: string | null;
  positionReports: number;
  distanceFlownKm: number;
  airborneHours: number;
  averageGroundSpeedKmh: number;
}
