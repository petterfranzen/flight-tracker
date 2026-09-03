import type { AircraftDossier, AircraftUsage, Bounds, ClusterPoint, FlightPosition, LiveMarker, PollingStatus } from "../types/flight";
import { clusterMockFleet, filterByBounds, getMockFleet, getMockPlaneCount } from "./mockFleet";

/**
 * Tracking is global, but a bounds-less call returns every aircraft being
 * tracked anywhere — the map always calls this with its current viewport,
 * which also reports that viewport as what the "hot" backend poll should
 * target next (see FlightController.live / ViewportService).
 */
export async function fetchLivePositions(bounds?: Bounds): Promise<LiveMarker[]> {
  const mockCount = getMockPlaneCount();
  if (mockCount != null) return filterByBounds(getMockFleet(mockCount), bounds);
  const query = bounds
    ? `?latMin=${bounds.latMin}&latMax=${bounds.latMax}&lonMin=${bounds.lonMin}&lonMax=${bounds.lonMax}`
    : "";
  const res = await fetch(`/api/flights/live${query}`);
  if (!res.ok) throw new Error(`live fetch failed: ${res.status}`);
  return res.json();
}

/**
 * Aggregated counterpart to fetchLivePositions, for a viewport too wide to
 * usefully render individual aircraft — see CLUSTER_FETCH_MAX_ZOOM in
 * FlightMap.tsx for where the map switches over, and FlightController.
 * liveClusters for gridDeg's own clamping.
 */
export async function fetchLiveClusters(bounds: Bounds, gridDeg: number): Promise<ClusterPoint[]> {
  const mockCount = getMockPlaneCount();
  if (mockCount != null) return clusterMockFleet(filterByBounds(getMockFleet(mockCount), bounds), gridDeg);
  const query = `?latMin=${bounds.latMin}&latMax=${bounds.latMax}&lonMin=${bounds.lonMin}&lonMax=${bounds.lonMax}&gridDeg=${gridDeg}`;
  const res = await fetch(`/api/flights/live/clusters${query}`);
  if (!res.ok) throw new Error(`live clusters fetch failed: ${res.status}`);
  return res.json();
}

/**
 * Worldwide count, independent of viewport — the "TRACKED" chip's own
 * number, not derived from whatever fetchLivePositions last returned for
 * the current viewport (that only ever covers what's on screen). A plain
 * count rather than reusing the bbox-less form of fetchLivePositions,
 * which would fetch every tracked aircraft's full row just to measure
 * how many there are.
 */
export async function fetchLiveCount(): Promise<number> {
  const mockCount = getMockPlaneCount();
  if (mockCount != null) return mockCount;
  const res = await fetch("/api/flights/live/count");
  if (!res.ok) throw new Error(`live count fetch failed: ${res.status}`);
  return res.json();
}

/**
 * Search-box autocomplete: live aircraft whose callsign matches `query`
 * (server ranks prefix matches first — see FlightController.search).
 */
export async function searchFlights(query: string): Promise<FlightPosition[]> {
  const res = await fetch(`/api/flights/search?q=${encodeURIComponent(query)}`);
  if (!res.ok) throw new Error(`flight search failed: ${res.status}`);
  return res.json();
}

/**
 * The "advanced search" panel's counterpart to searchFlights: live
 * aircraft whose origin OR destination airport matches `query` (name,
 * IATA code, ICAO code, or city — see FlightController.search).
 */
export async function searchFlightsByAirport(query: string): Promise<FlightPosition[]> {
  const res = await fetch(`/api/flights/search?airport=${encodeURIComponent(query)}`);
  if (!res.ok) throw new Error(`flight airport search failed: ${res.status}`);
  return res.json();
}

/**
 * Priority single-aircraft refresh for whichever aircraft is currently
 * selected — independent of any viewport, unlike fetchLivePositions. See
 * FlightController.liveOne for why this exists as its own endpoint rather
 * than reusing /live. Null on 404 (aircraft has no position on record at
 * all), same convention as fetchAircraftDossier.
 */
export async function fetchFlightLive(icao24: string): Promise<FlightPosition | null> {
  const res = await fetch(`/api/flights/${icao24}/live`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`flight live fetch failed: ${res.status}`);
  return res.json();
}

export async function fetchHistory(icao24: string, from: string, to: string): Promise<FlightPosition[]> {
  const res = await fetch(`/api/flights/${icao24}/history?from=${from}&to=${to}`);
  if (!res.ok) throw new Error(`history fetch failed: ${res.status}`);
  return res.json();
}

export async function fetchAircraftDossier(icao24: string): Promise<AircraftDossier | null> {
  const res = await fetch(`/api/aircraft/${icao24}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`aircraft fetch failed: ${res.status}`);
  return res.json();
}

export async function fetchUsage(from: string, to: string): Promise<AircraftUsage[]> {
  const res = await fetch(`/api/usage?from=${from}&to=${to}`);
  if (!res.ok) throw new Error(`usage fetch failed: ${res.status}`);
  return res.json();
}

export async function fetchPollingStatus(): Promise<PollingStatus> {
  const res = await fetch("/api/agents/status");
  if (!res.ok) throw new Error(`polling status fetch failed: ${res.status}`);
  return res.json();
}

export interface RestartOutcome {
  status: PollingStatus;
  rateLimited: boolean;
  /** From the response's Retry-After header — only ever set on the global-quota rejection, not the per-IP one (see AgentController.restart). */
  retryAfterSeconds: number | null;
}

/**
 * Doesn't throw on 429 the way the other fetch* functions throw on any
 * non-ok status — a resume being rate-limited (see AgentController's
 * javadoc on /restart: a per-IP limit, or the shared OpenSky-usage quota)
 * is an expected outcome now that this is internet-facing, not a fetch
 * failure, so the caller can show a real message instead of an unhandled
 * rejection.
 */
export async function restartPolling(): Promise<RestartOutcome> {
  const res = await fetch("/api/agents/restart", { method: "POST" });
  if (res.status === 429) {
    const retryAfterHeader = res.headers.get("Retry-After");
    return {
      status: await res.json(),
      rateLimited: true,
      retryAfterSeconds: retryAfterHeader ? Number(retryAfterHeader) : null,
    };
  }
  if (!res.ok) throw new Error(`polling restart failed: ${res.status}`);
  return { status: await res.json(), rateLimited: false, retryAfterSeconds: null };
}

/** Subscribes to the live push feed; returns an unsubscribe function. */
export function subscribeLiveFeed(onPosition: (p: FlightPosition) => void): () => void {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const socket = new WebSocket(`${proto}://${location.host}/ws/live`);
  socket.onmessage = (event) => {
    try {
      onPosition(JSON.parse(event.data) as FlightPosition);
    } catch {
      // ignore malformed frame
    }
  };
  return () => socket.close();
}

/**
 * Real terminal/apron/hangar/gate geometry for one airport, from
 * OpenStreetMap via the backend's Overpass proxy (see
 * AirportGatesController/OverpassAirportGatesClient) — a direct browser
 * call to Overpass itself is blocked by CORS (confirmed: its responses
 * carry no Access-Control-Allow-Origin header), so this has to be
 * server-proxied regardless of how the request is shaped. VectorBasemap
 * only calls this once zoomed in close enough on a specific airport to
 * actually show this level of detail, and caches results client-side on
 * top of the backend's own cache.
 */
export interface AirportGateFeature {
  kind: "gate" | "apron" | "terminal" | "hangar";
  ring: [number, number][];
}
export async function fetchAirportGates(code: string, lat: number, lon: number): Promise<AirportGateFeature[]> {
  const res = await fetch(`/api/airports/gates?code=${encodeURIComponent(code)}&lat=${lat}&lon=${lon}`);
  if (!res.ok) throw new Error(`airport gates fetch failed: ${res.status}`);
  return res.json();
}
