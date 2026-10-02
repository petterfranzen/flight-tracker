import type { AircraftDossier, AirportInfo, AircraftUsage, Bounds, ClusterPoint, FlightPosition, LiveMarker, LiveOverview, PollingStatus } from "../types/flight";
import { clusterMockFleet, filterByBounds, getMockFleet, getMockPlaneCount } from "./mockFleet";

/**
 * Individual aircraft inside `bounds` — the map only calls this at or above
 * CLUSTER_FETCH_MAX_ZOOM (see main.ts), always with its current viewport,
 * which also reports that viewport as what the "hot" backend poll and the
 * WebSocket broadcast should target next (see FlightController.live /
 * ViewportService). `bounds` is required on purpose: the server's
 * bounds-less form returns every tracked aircraft worldwide (~3 MB at
 * 10k aircraft), which the map must never ask for.
 */
export async function fetchLivePositions(bounds: Bounds, signal?: AbortSignal): Promise<LiveMarker[]> {
  const mockCount = getMockPlaneCount();
  if (mockCount != null) return filterByBounds(getMockFleet(mockCount), bounds);
  const query = `?latMin=${bounds.latMin}&latMax=${bounds.latMax}&lonMin=${bounds.lonMin}&lonMax=${bounds.lonMax}`;
  const res = await fetch(`/api/flights/live${query}`, { signal });
  if (!res.ok) throw new Error(`live fetch failed: ${res.status}`);
  return res.json();
}

/**
 * Aggregated counterpart to fetchLivePositions, for a viewport too wide to
 * usefully render individual aircraft — see CLUSTER_FETCH_MAX_ZOOM in
 * main.ts for where the map switches over, and FlightController.
 * liveClusters for gridDeg's own clamping.
 */
export async function fetchLiveClusters(bounds: Bounds, gridDeg: number, signal?: AbortSignal): Promise<ClusterPoint[]> {
  const mockCount = getMockPlaneCount();
  if (mockCount != null) return clusterMockFleet(filterByBounds(getMockFleet(mockCount), bounds), gridDeg);
  const query = `?latMin=${bounds.latMin}&latMax=${bounds.latMax}&lonMin=${bounds.lonMin}&lonMax=${bounds.lonMax}&gridDeg=${gridDeg}`;
  const res = await fetch(`/api/flights/live/clusters${query}`, { signal });
  if (!res.ok) throw new Error(`live clusters fetch failed: ${res.status}`);
  return res.json();
}

/**
 * The zoomed-out view: the most active aircraft as individual markers plus
 * clusters for everything else. Replaces fetchLiveClusters for the map's
 * own zoomed-out fetch so the world doesn't look empty — see
 * LiveStateStore.overview for the ranking.
 */
export async function fetchLiveOverview(bounds: Bounds, gridDeg: number, signal?: AbortSignal): Promise<LiveOverview> {
  const mockCount = getMockPlaneCount();
  if (mockCount != null) {
    const inView = filterByBounds(getMockFleet(mockCount), bounds);
    const planes = inView.slice(0, 200);
    return { planes, clusters: clusterMockFleet(inView.slice(200), gridDeg) };
  }
  const query = `?latMin=${bounds.latMin}&latMax=${bounds.latMax}&lonMin=${bounds.lonMin}&lonMax=${bounds.lonMax}&gridDeg=${gridDeg}`;
  const res = await fetch(`/api/flights/live/overview${query}`, { signal });
  if (!res.ok) throw new Error(`live overview fetch failed: ${res.status}`);
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

// Capped exponential backoff for WS reconnects: first retry after 1s,
// doubling on every further consecutive failure, capped at 30s, with ±25%
// jitter so a server restart doesn't get every open tab reconnecting in
// lock-step.
const WS_RECONNECT_MIN_MS = 1_000;
const WS_RECONNECT_MAX_MS = 30_000;
// Backoff only resets once a connection has *stayed* up this long. It used
// to reset in onopen, so a socket the server accepted (101) and then
// dropped — e.g. closing it 1011 after its send buffer to us overflowed —
// reconnected every 1s forever instead of backing off.
const WS_STABLE_AFTER_MS = 15_000;
// Close codes where retrying the same request can never succeed (1002
// protocol error, 1003 unsupported data, 1008 policy violation) — stop
// instead of hammering the server; a reload starts over.
const WS_FATAL_CLOSE_CODES = new Set([1002, 1003, 1008]);

function isFlightPosition(data: unknown): data is FlightPosition {
  if (!data || typeof data !== "object") return false;
  const p = data as Record<string, unknown>;
  return typeof p.icao24 === "string" && typeof p.observedAt === "string";
}

/** Same-origin /ws/live, ws:// or wss:// to match the page (Cloudflare serves https, so wss). */
export function liveFeedUrl(loc: Pick<Location, "href" | "protocol"> = location): string {
  const url = new URL("/ws/live", loc.href);
  url.protocol = loc.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

/**
 * Subscribes to the live push feed; returns an unsubscribe function.
 *
 * Keepalive: the backend sends native WS ping frames every 30s, which the
 * browser answers itself — they never reach `onmessage`. A `{"type":"ping"}`
 * text frame (the fallback PLAN.md §6 item 9 mentions) is also tolerated:
 * it isn't a FlightPosition, so it's dropped like any other non-position
 * frame.
 *
 * Reconnects on any unexpected close with capped, jittered exponential
 * backoff (see the constants above). Never touches /api/agents/restart:
 * reopening the poll window is a page-load / Resume-button decision only.
 */
export function subscribeLiveFeed(onPosition: (p: FlightPosition) => void): () => void {
  let socket: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let stableTimer: ReturnType<typeof setTimeout> | null = null;
  let backoffMs = WS_RECONNECT_MIN_MS;
  let stopped = false;

  function connect(): void {
    reconnectTimer = null;
    if (stopped) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(liveFeedUrl());
    } catch {
      scheduleReconnect();
      return;
    }
    socket = ws;
    // Every handler below checks `ws === socket`: events from a socket that
    // has already been replaced must never touch the current one (the old
    // onerror called `socket?.close()` on the shared variable, which could
    // close the *new* connection).
    ws.onopen = () => {
      if (ws !== socket) return;
      stableTimer = setTimeout(() => {
        backoffMs = WS_RECONNECT_MIN_MS;
      }, WS_STABLE_AFTER_MS);
    };
    ws.onmessage = (event) => {
      if (ws !== socket || typeof event.data !== "string") return;
      let data: unknown;
      try {
        data = JSON.parse(event.data);
      } catch {
        return; // ignore malformed frame
      }
      if (isFlightPosition(data)) onPosition(data);
    };
    // onerror is always followed by onclose; reconnect is handled there, once.
    ws.onerror = () => {};
    ws.onclose = (event) => {
      if (ws !== socket) return;
      socket = null;
      if (stableTimer) clearTimeout(stableTimer);
      stableTimer = null;
      if (stopped) return;
      if (WS_FATAL_CLOSE_CODES.has(event.code)) {
        console.warn(`live feed closed with ${event.code} (${event.reason || "no reason"}) — not reconnecting`);
        return;
      }
      scheduleReconnect();
    };
  }

  function scheduleReconnect(): void {
    if (stopped || reconnectTimer) return;
    const delay = Math.round(backoffMs * (0.75 + Math.random() * 0.5));
    backoffMs = Math.min(WS_RECONNECT_MAX_MS, backoffMs * 2);
    reconnectTimer = setTimeout(connect, delay);
  }

  // Back online after a network drop: don't sit out the rest of a 30s backoff.
  function onOnline(): void {
    if (stopped || socket) return;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    backoffMs = WS_RECONNECT_MIN_MS;
    connect();
  }
  window.addEventListener("online", onOnline);

  connect();
  return () => {
    stopped = true;
    window.removeEventListener("online", onOnline);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (stableTimer) clearTimeout(stableTimer);
    socket?.close(1000);
    socket = null;
  };
}

/**
 * Static name/municipality/country for the airport dossier panel — see
 * AirportController.info. Null on 404 (a code the bundled AIRPORTS data
 * has but the reference table doesn't), same convention as
 * fetchAircraftDossier.
 */
export async function fetchAirportInfo(code: string): Promise<AirportInfo | null> {
  const res = await fetch(`/api/airports/info?code=${encodeURIComponent(code)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`airport info fetch failed: ${res.status}`);
  return res.json();
}
