import type { AircraftDossier, AircraftUsage, Bounds, ClusterPoint, FlightPosition, PollingStatus } from "../types/flight";

/**
 * Tracking is global, but a bounds-less call returns every aircraft being
 * tracked anywhere — the map always calls this with its current viewport,
 * which also reports that viewport as what the "hot" backend poll should
 * target next (see FlightController.live / ViewportService).
 */
export async function fetchLivePositions(bounds?: Bounds): Promise<FlightPosition[]> {
  const query = bounds
    ? `?latMin=${bounds.latMin}&latMax=${bounds.latMax}&lonMin=${bounds.lonMin}&lonMax=${bounds.lonMax}`
    : "";
  const res = await fetch(`/api/flights/live${query}`);
  if (!res.ok) throw new Error(`live fetch failed: ${res.status}`);
  return res.json();
}

/**
 * The zoomed-way-out counterpart to fetchLivePositions: server-aggregated
 * counts per gridDeg-sized cell instead of one row per aircraft. See
 * FlightMap's CLUSTER_FETCH_MAX_ZOOM for when the map switches to this.
 */
export async function fetchLiveClusters(bounds: Bounds, gridDeg: number): Promise<ClusterPoint[]> {
  const query = `?latMin=${bounds.latMin}&latMax=${bounds.latMax}&lonMin=${bounds.lonMin}&lonMax=${bounds.lonMax}&gridDeg=${gridDeg}`;
  const res = await fetch(`/api/flights/live/clusters${query}`);
  if (!res.ok) throw new Error(`live clusters fetch failed: ${res.status}`);
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
 * aircraft matching origin and/or destination airport (code or name).
 * Either may be omitted — pass "" for the one that's blank — but at least
 * one non-blank value is expected; the server treats both blank the same
 * as no filter at all (see FlightController.search), which isn't a useful
 * call to make from here.
 */
export async function searchFlightsByRoute(origin: string, destination: string): Promise<FlightPosition[]> {
  const params = new URLSearchParams();
  if (origin.trim()) params.set("origin", origin.trim());
  if (destination.trim()) params.set("destination", destination.trim());
  const res = await fetch(`/api/flights/search?${params.toString()}`);
  if (!res.ok) throw new Error(`flight route search failed: ${res.status}`);
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
