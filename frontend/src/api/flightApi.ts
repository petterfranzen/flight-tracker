import type { AircraftDossier, AircraftUsage, FlightPosition } from "../types/flight";

export async function fetchLivePositions(withinMinutes = 10): Promise<FlightPosition[]> {
  const res = await fetch(`/api/flights/live?withinMinutes=${withinMinutes}`);
  if (!res.ok) throw new Error(`live fetch failed: ${res.status}`);
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
