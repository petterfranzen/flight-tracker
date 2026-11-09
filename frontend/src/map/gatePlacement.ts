import type { LatLon } from "./map";
import type { SelectedPosition, TrackStatus } from "../types/flight";

// A provider-confirmed gate (TrackStatus AT_GATE, with a gate ref) beats a
// radar position that is old: a plane that landed, rolled out and taxied out
// of coverage is last seen at the runway end, but it is at its stand. This is
// a display state only: the position stays the last report (the dossier's
// "last updated", the as-of time, flight_position and the LiveFrame are all
// untouched), the map just draws the plane where it is known to be.

/** A report older than this, with a confirmed gate, is drawn at the gate. */
export const GATE_STALE_MS = 10 * 60_000;

/** A report this long after the gate-in time is a later movement (pushback, next flight): not the arrival. */
export const GATE_LATER_MOVEMENT_MS = 10 * 60_000;

/** Furthest a gate of this ref may be from where the plane was last seen, m: it is at the same airport. */
export const GATE_MAX_DISTANCE_M = 15_000;

export interface GateDisplay {
  lat: number;
  lon: number;
  /** The gate ref, for the label. */
  gate: string;
}

export function distanceM(a: LatLon, b: LatLon): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

/** The gate to look up for this plane, or null: only a confirmed arrival at a named gate qualifies. */
export function confirmedGate(pos: SelectedPosition | null, status: TrackStatus | null): string | null {
  if (!pos || !status || status.icao24 !== pos.icao24 || status.state !== "AT_GATE") return null;
  const gate = status.gate?.trim();
  return gate ? gate : null;
}

/**
 * Where to draw the selected plane instead of its last report, or null to
 * draw the report. Confirmed gate and either an old report or one on the
 * ground; `gatePoint` is the gate's coordinate (null: not known, so nothing
 * to move to). A report well after the confirmed gate-in is the plane moving
 * again, and is drawn where it is.
 */
export function gateDisplay(pos: SelectedPosition | null, status: TrackStatus | null, nowMs: number, gatePoint: LatLon | null): GateDisplay | null {
  const gate = confirmedGate(pos, status);
  if (!pos || !status || !gate || !gatePoint) return null;
  const observed = Date.parse(pos.observedAt);
  const gateIn = status.confirmedAt ? Date.parse(status.confirmedAt) : NaN;
  if (Number.isFinite(gateIn) && observed > gateIn + GATE_LATER_MOVEMENT_MS) return null;
  const stale = nowMs - observed > GATE_STALE_MS;
  if (!stale && pos.onGround !== true) return null;
  if (distanceM({ lat: status.lastSeenLat, lon: status.lastSeenLon }, gatePoint) > GATE_MAX_DISTANCE_M) return null;
  return { lat: gatePoint.lat, lon: gatePoint.lon, gate };
}

/** The selected plane as the map draws it: at the gate with the gate in its label, heading unknown there; else as reported. */
export function displayedPosition(pos: SelectedPosition, display: GateDisplay | null): SelectedPosition {
  if (!display) return pos;
  const callsign = pos.callsign?.trim() || pos.icao24.toUpperCase();
  return { ...pos, latitude: display.lat, longitude: display.lon, headingDeg: null, callsign: `${callsign} · ${display.gate}` };
}

export interface TrailPoint {
  lat: number;
  lon: number;
  observedAt: string;
}

/**
 * The trail to draw. Real reports only, in time order, none after the last
 * observation. Normally it ends at the marker (which can be a dead-reckoned
 * estimate: a movable tip). When the plane is drawn at its gate, the trail
 * must not run on to the gate (that stretch was never reported) and, if the
 * last report is old, it is not drawn at all: it would end away from the
 * plane, at wherever coverage was lost.
 */
export function trailFor(
  points: TrailPoint[],
  tip: { latitude: number; longitude: number; observedAt: string } | null,
  display: GateDisplay | null,
  nowMs: number,
): [number, number][] {
  const until = tip ? Date.parse(tip.observedAt) : Infinity;
  const real = points
    .filter((pt) => Date.parse(pt.observedAt) <= until)
    .sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt))
    .map((pt): [number, number] => [pt.lat, pt.lon]);
  if (display) {
    const last = tip ? Date.parse(tip.observedAt) : NaN;
    return Number.isFinite(last) && nowMs - last > GATE_STALE_MS ? [] : real;
  }
  const end = real[real.length - 1];
  if (tip && !(end && end[0] === tip.latitude && end[1] === tip.longitude)) real.push([tip.latitude, tip.longitude]);
  return real;
}

/** The first coordinate of a GeoJSON geometry as lat/lon: a gate is a point, but a mapped one may be an area. */
export function geometryPoint(geometry: { type: string; coordinates?: unknown } | null | undefined): LatLon | null {
  let c: unknown = geometry?.coordinates;
  while (Array.isArray(c) && Array.isArray(c[0])) c = c[0];
  if (!Array.isArray(c) || typeof c[0] !== "number" || typeof c[1] !== "number") return null;
  return { lat: c[1], lon: c[0] };
}
