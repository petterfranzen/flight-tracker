import type { AircraftDossier, AirportInfo, AircraftUsage, Bounds, ClusterPoint, FlightPosition, LiveMarker, LiveOverview, PollingStatus, TrackStatus } from "../types/flight";
import { clusterMockFleet, filterByBounds, getMockFleet, getMockPlaneCount } from "./mockFleet";

export { liveFeedUrl, subscribeLiveFeed, type LiveFeedOptions } from "./liveFeed";

interface JsonRequest {
  url: string;
  /** Names the request in the error: "<what> failed: <status>". */
  what: string;
  signal?: AbortSignal;
}

/** GET a JSON endpoint; a non-ok status throws "<what> failed: <status>". */
async function getJson<T>({ url, what, signal }: JsonRequest): Promise<T> {
  const res = await fetch(url, signal ? { signal } : undefined);
  if (!res.ok) throw new Error(`${what} failed: ${res.status}`);
  return res.json();
}

/** As getJson, but a 404 (nothing on record) reads as null. */
async function getJsonOrNull<T>({ url, what }: JsonRequest): Promise<T | null> {
  const res = await fetch(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${what} failed: ${res.status}`);
  return res.json();
}

/** An aircraft's ICAO 24-bit address (hex), as the API paths take it. */
export type Icao24 = string;
/** An ISO-8601 instant, as the history and usage endpoints take it. */
export type IsoInstant = string;

const boundsQuery = (b: Bounds): string => `?latMin=${b.latMin}&latMax=${b.latMax}&lonMin=${b.lonMin}&lonMax=${b.lonMax}`;

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
  return getJson({ url: `/api/flights/live${boundsQuery(bounds)}`, what: "live fetch", signal });
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
  return getJson({ url: `/api/flights/live/clusters${boundsQuery(bounds)}&gridDeg=${gridDeg}`, what: "live clusters fetch", signal });
}

/**
 * The zoomed-out view: active aircraft, at most one per cell of `cellDeg`
 * (half an icon), first discovered first — see LiveStateStore.discovered.
 * No clusters; the map hides whatever still overlaps (map/declutter.ts).
 */
// A generous cap: one plane per half-icon cell is a few hundred on a laptop screen, so this is a safety net.
const OVERVIEW_PLANES = 1500;

export async function fetchLiveOverview(bounds: Bounds, cellDeg: number, signal?: AbortSignal): Promise<LiveOverview> {
  const mockCount = getMockPlaneCount();
  if (mockCount != null) {
    return { planes: filterByBounds(getMockFleet(mockCount), bounds).slice(0, OVERVIEW_PLANES), clusters: [] };
  }
  const query = `${boundsQuery(bounds)}&gridDeg=${cellDeg}&limit=${OVERVIEW_PLANES}&declutter=true`;
  return getJson({ url: `/api/flights/live/overview${query}`, what: "live overview fetch", signal });
}

/**
 * The visitor's approximate location (server: GeoLocator, from Cloudflare's
 * visitor-location headers), or null when there is none (204: local dev, no
 * headers) or the request fails. Coarse, ~11 km. Only ever used to choose the
 * opening view, so every failure is just "no location".
 */
export async function fetchGeo(signal?: AbortSignal): Promise<{ lat: number; lon: number } | null> {
  try {
    const res = await fetch("/api/geo", { signal });
    if (res.status !== 200) return null;
    const g = (await res.json()) as { lat?: unknown; lon?: unknown };
    return typeof g.lat === "number" && typeof g.lon === "number" ? { lat: g.lat, lon: g.lon } : null;
  } catch {
    return null;
  }
}

/**
 * Worldwide count of *active* aircraft (in the air, reported within the last
 * 2 h), independent of viewport — the "ACTIVE" chip's own number, not derived
 * from whatever fetchLivePositions last returned for the current viewport
 * (that only ever covers what's on screen). The server still remembers many
 * more (landed or silent ones, shown dimmed up close); those are not what the
 * chip counts. A plain count rather than reusing the bbox-less form of
 * fetchLivePositions, which would fetch every row just to measure how many
 * there are.
 */
/** `active`: only aircraft in the air and heard from recently; otherwise everything the server still holds. */
export async function fetchLiveCount(active = true): Promise<number> {
  const mockCount = getMockPlaneCount();
  if (mockCount != null) return mockCount;
  return getJson({ url: `/api/flights/live/count${active ? "?active=true" : ""}`, what: "live count fetch" });
}

/**
 * Search-box autocomplete: live aircraft whose callsign matches `query`
 * (server ranks prefix matches first — see FlightController.search).
 */
export async function searchFlights(query: string): Promise<FlightPosition[]> {
  return getJson({ url: `/api/flights/search?q=${encodeURIComponent(query)}`, what: "flight search" });
}

/**
 * The "advanced search" panel's counterpart to searchFlights: live
 * aircraft whose origin OR destination airport matches `query` (name,
 * IATA code, ICAO code, or city — see FlightController.search).
 */
export async function searchFlightsByAirport(query: string): Promise<FlightPosition[]> {
  return getJson({ url: `/api/flights/search?airport=${encodeURIComponent(query)}`, what: "flight airport search" });
}

/**
 * Priority single-aircraft refresh for whichever aircraft is currently
 * selected — independent of any viewport, unlike fetchLivePositions. See
 * FlightController.liveOne for why this exists as its own endpoint rather
 * than reusing /live. Null on 404 (aircraft has no position on record at
 * all), same convention as fetchAircraftDossier.
 */
export async function fetchFlightLive(icao24: Icao24): Promise<FlightPosition | null> {
  return getJsonOrNull({ url: `/api/flights/${icao24}/live`, what: "flight live fetch" });
}

/**
 * What the tracker believes about one aircraft beyond its last report (live,
 * coverage lost, landed…) — FlightController's /status. Null on 404 (not in
 * the live set), and on any failure or in the mock-fleet dev mode: the status
 * is an extra, never a reason to break the selection.
 */
export async function fetchFlightStatus(icao24: Icao24): Promise<TrackStatus | null> {
  if (getMockPlaneCount() != null) return null;
  try {
    const res = await fetch(`/api/flights/${icao24}/status`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function fetchHistory(icao24: Icao24, from: IsoInstant, to: IsoInstant): Promise<FlightPosition[]> {
  return getJson({ url: `/api/flights/${icao24}/history?from=${from}&to=${to}`, what: "history fetch" });
}

export async function fetchAircraftDossier(icao24: Icao24): Promise<AircraftDossier | null> {
  return getJsonOrNull({ url: `/api/aircraft/${icao24}`, what: "aircraft fetch" });
}

export async function fetchUsage(from: IsoInstant, to: IsoInstant): Promise<AircraftUsage[]> {
  return getJson({ url: `/api/usage?from=${from}&to=${to}`, what: "usage fetch" });
}

export async function fetchPollingStatus(): Promise<PollingStatus> {
  return getJson({ url: "/api/agents/status", what: "polling status fetch" });
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

/**
 * Static name/municipality/country for the airport dossier panel — see
 * AirportController.info. Null on 404 (a code the bundled AIRPORTS data
 * has but the reference table doesn't), same convention as
 * fetchAircraftDossier.
 */
export async function fetchAirportInfo(code: string): Promise<AirportInfo | null> {
  return getJsonOrNull({ url: `/api/airports/info?code=${encodeURIComponent(code)}`, what: "airport info fetch" });
}

/** One row of a Swedavia board (ScheduleController); `icao24` is set once the flight is airborne in live state. */
export interface ScheduledFlight {
  flightNumber: string;
  callsign: string | null;
  direction: "arrivals" | "departures";
  airport: string;
  departureIata: string | null;
  arrivalIata: string | null;
  scheduled: string | null;
  estimated: string | null;
  actual: string | null;
  gate: string | null;
  terminal: string | null;
  statusCode: string | null;
  status: string | null;
  icao24: string | null;
  airborne: boolean;
}

/** The board's own health for one search, from the X-Schedule-Status header. */
export type ScheduleStatus = "ok" | "stale" | "incomplete";

/** /api/schedule/search parameters: `flight` (BA778), or `from`/`to` (comma-separated IATA codes); unset ones are left out. */
export interface ScheduleQuery {
  flight?: string;
  from?: string;
  to?: string;
  airport?: string;
  date?: string;
}

export interface ScheduleSearchResult {
  rows: ScheduledFlight[];
  status: ScheduleStatus;
}

/**
 * Search the schedule by `flight` (BA778) or by `from`/`to` (comma-separated
 * IATA codes) and keep the board's health header. A failed board must never
 * raise a notification (#82 design §3), so the detector reads `status`.
 */
export async function searchScheduleWithStatus(p: ScheduleQuery): Promise<ScheduleSearchResult> {
  const res = await fetch(`/api/schedule/search?${scheduleParams(p)}`);
  if (res.status === 503) throw new Error("Schedules are not available (no Swedavia key)");
  if (!res.ok) throw new Error(`Search failed (${res.status})`);
  return { rows: await res.json(), status: scheduleStatus(res.headers) };
}

/** The query's set fields only, in the order given. */
function scheduleParams(p: ScheduleQuery): URLSearchParams {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) {
    if (v) qs.set(k, v);
  }
  return qs;
}

/** The board's health from the X-Schedule-Status header; anything else reads as "ok". */
function scheduleStatus(headers: Headers): ScheduleStatus {
  const header = headers.get("X-Schedule-Status");
  return header === "stale" || header === "incomplete" ? header : "ok";
}

/** Search the schedule by `flight` (BA778) or by `from`/`to` (comma-separated IATA codes); throws with the server's reason. */
export async function searchSchedule(p: ScheduleQuery): Promise<ScheduledFlight[]> {
  return (await searchScheduleWithStatus(p)).rows;
}
