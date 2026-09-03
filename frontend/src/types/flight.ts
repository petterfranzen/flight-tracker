/** A lat/lon bounding box — the current map viewport. */
export interface Bounds {
  latMin: number;
  latMax: number;
  lonMin: number;
  lonMax: number;
}

/**
 * One grid cell's worth of aggregated live traffic — FlightController.
 * liveClusters's own summary tier for a viewport too wide to usefully
 * render individual aircraft (a continent or the whole world can mean
 * tens of thousands of them: confirmed to freeze rendering entirely, not
 * just feel slow, on a real deploy). See CLUSTER_FETCH_MAX_ZOOM in
 * FlightMap.tsx for where the map switches over.
 */
export interface ClusterPoint {
  lat: number;
  lon: number;
  count: number;
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

/**
 * What the map's bulk viewport fetch (fetchLivePositions) actually returns
 * — see FlightController.live's javadoc on the backend. Everything needed
 * to draw and select a marker (identity, position, heading, the observedAt
 * FlightMap.tsx's merge logic orders updates by) and nothing else: at a
 * continent or world-sized viewport this can be tens of thousands of rows,
 * and every field FlightPosition carries beyond this is only ever read
 * once an aircraft is actually selected — fetchFlightLive/fetchAircraftDossier
 * fetch that full detail directly by icao24 at that point instead. A
 * FlightPosition always structurally satisfies this (it's a superset), so
 * the two interoperate freely — nothing needs an explicit conversion.
 */
export interface LiveMarker {
  icao24: string;
  callsign: string | null;
  observedAt: string; // ISO instant
  latitude: number;
  longitude: number;
  headingDeg: number | null;
}

/**
 * FlightMap's selectedPos: a LiveMarker plus the one extra field the
 * details panel reads directly (altitude — everything else it shows comes
 * from the separate AircraftDossier fetch). Populated instantly from
 * whatever LiveMarker triggered the selection (altitudeM starts null,
 * exactly like the dossier fields' own "—" until loaded convention), then
 * upgraded to the real value moments later by the dedicated priority
 * fetchFlightLive poll or a WebSocket push, both of which return a full
 * FlightPosition — again a structural superset, so no conversion needed.
 */
export type SelectedPosition = LiveMarker & { altitudeM: number | null };

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
