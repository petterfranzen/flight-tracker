import type { Bounds, ClusterPoint, FlightPosition } from "../types/flight";

/**
 * Client-side synthetic fleet for stress-testing map/marker rendering
 * performance without a real backend — enabled via ?mockPlanes=N in the
 * URL (e.g. http://localhost:5183/?mockPlanes=1500), read by
 * fetchLivePositions/fetchLiveCount in flightApi.ts. Not wired into
 * any UI control; a deliberate, URL-triggered dev tool, off by default.
 * Only seeds positions — a mock aircraft's dossier/history endpoints
 * aren't faked, so selecting one won't show real details, just an empty
 * state; this is for render/pan/zoom load, not full interaction fidelity.
 */

const CLUSTER_CENTERS: { lat: number; lon: number }[] = [
  { lat: 51.5074, lon: -0.1278 }, // London
  { lat: 40.7128, lon: -74.006 }, // New York
  { lat: -33.8688, lon: 151.2093 }, // Sydney
];
// Fraction of the fleet placed near each cluster center above (in order);
// the remainder scatters globally.
const CLUSTER_FRACTION = 0.15;

let cachedFleet: FlightPosition[] | null = null;

function randomHex(len: number): string {
  let s = "";
  for (let i = 0; i < len; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s;
}

function randomPosition(): { latitude: number; longitude: number } {
  const r = Math.random();
  const clusterIndex = Math.floor(r / CLUSTER_FRACTION);
  const center = clusterIndex < CLUSTER_CENTERS.length ? CLUSTER_CENTERS[clusterIndex] : null;
  if (center) {
    // A few-hundred-km scatter around the center — dense enough to read
    // as a real regional cluster, not a single overlapping point.
    return {
      latitude: Math.max(-85, Math.min(85, center.lat + (Math.random() - 0.5) * 6)),
      longitude: Math.max(-180, Math.min(180, center.lon + (Math.random() - 0.5) * 6)),
    };
  }
  // Uniform over the sphere (not the lat/lon rectangle, which would
  // visibly bunch points near the poles) via an arcsine latitude draw.
  return {
    latitude: (Math.asin(Math.random() * 2 - 1) * 180) / Math.PI,
    longitude: Math.random() * 360 - 180,
  };
}

function generateFleet(count: number): FlightPosition[] {
  const now = new Date().toISOString();
  return Array.from({ length: count }, (_, i) => {
    const { latitude, longitude } = randomPosition();
    return {
      id: i,
      icao24: randomHex(6),
      callsign: `MOCK${String(i).padStart(4, "0")}`,
      observedAt: now,
      latitude,
      longitude,
      altitudeM: 3000 + Math.random() * 9000,
      velocityMs: 150 + Math.random() * 100,
      headingDeg: Math.random() * 360,
      verticalRateMs: (Math.random() - 0.5) * 5,
      onGround: false,
      agentSource: "mock",
    };
  });
}

/** Nudges the existing fleet so repeated polls look "live" without real physics — same icao24 set every call, just moved a little. */
function jitterFleet(fleet: FlightPosition[]): FlightPosition[] {
  const now = new Date().toISOString();
  return fleet.map((p) => ({
    ...p,
    observedAt: now,
    latitude: Math.max(-85, Math.min(85, p.latitude + (Math.random() - 0.5) * 0.3)),
    longitude: Math.max(-180, Math.min(180, p.longitude + (Math.random() - 0.5) * 0.3)),
  }));
}

export function getMockFleet(count: number): FlightPosition[] {
  cachedFleet = !cachedFleet || cachedFleet.length !== count ? generateFleet(count) : jitterFleet(cachedFleet);
  return cachedFleet;
}

export function getMockPlaneCount(): number | null {
  const raw = new URLSearchParams(location.search).get("mockPlanes");
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

export function filterByBounds(positions: FlightPosition[], bounds?: Bounds): FlightPosition[] {
  if (!bounds) return positions;
  return positions.filter(
    (p) => p.latitude >= bounds.latMin && p.latitude <= bounds.latMax && p.longitude >= bounds.lonMin && p.longitude <= bounds.lonMax,
  );
}

/** Mirrors FlightPositionRepository.findLiveClusteredInBounds's own bucketing so the mock-fleet dev tool (?mockPlanes=N) still has something to show once zoomed out past CLUSTER_FETCH_MAX_ZOOM. */
export function clusterMockFleet(positions: FlightPosition[], gridDeg: number): ClusterPoint[] {
  const buckets = new Map<string, ClusterPoint>();
  for (const p of positions) {
    const bucketLat = Math.floor(p.latitude / gridDeg) * gridDeg;
    const bucketLon = Math.floor(p.longitude / gridDeg) * gridDeg;
    const key = `${bucketLat},${bucketLon}`;
    const existing = buckets.get(key);
    if (existing) existing.count++;
    else buckets.set(key, { lat: bucketLat + gridDeg / 2, lon: bucketLon + gridDeg / 2, count: 1 });
  }
  return Array.from(buckets.values());
}
