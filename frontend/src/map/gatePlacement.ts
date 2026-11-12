import type { LatLon } from "./map";
import type { SelectedPosition, TrackStatus } from "../types/flight";

// A provider-confirmed gate (a TrackStatus carrying a gate ref) beats a radar
// position that is old: a plane that landed, rolled out and taxied out of
// coverage is last seen at the runway end, but it is at its stand. This is a
// display state only: the position stays the last report (the dossier's
// "last updated", the as-of time, flight_position and the LiveFrame are all
// untouched), the map just draws the plane where it is known to be.
//
// AT_GATE and LANDED_CONFIRMED both qualify: a provider that named the gate
// has told us where the plane is, and the confirmation can name the gate
// before the state has moved on to "at gate". The two are not the same,
// though: for LANDED_CONFIRMED `confirmedAt` is the touchdown time, so only a
// stale report is drawn at the gate (a fresh one is the plane taxiing in) and
// the later-movement rule below does not apply to it.

/** A report older than this, with a confirmed gate, is drawn at the gate. */
export const GATE_STALE_MS = 10 * 60_000;

/** A report this long after the gate-in time is a later movement (pushback, next flight): not the arrival. */
export const GATE_LATER_MOVEMENT_MS = 10 * 60_000;

/** Furthest a gate of this ref may be from where the plane was last seen, m: it is at the same airport. */
export const GATE_MAX_DISTANCE_M = 15_000;

/** A coordinate a confirmed gate resolves to: the gate's own point, or a guessed point in the airport's terminal area. */
export interface GatePoint {
  lat: number;
  lon: number;
  /** True when this is a guess (the nearest indexed gate or stand), not the gate itself: the label says "Gate <ref>". */
  approximate?: boolean;
}

export interface GateDisplay {
  lat: number;
  lon: number;
  /** The gate ref, for the label. */
  gate: string;
  /** The point is a terminal-area guess rather than the gate itself, so the marker says "Gate <ref>". */
  approximate: boolean;
}

export function distanceM(a: LatLon, b: LatLon): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

/**
 * The gate to look up for this plane, or null: only a confirmed arrival at a
 * named gate qualifies. AT_GATE is a confirmed arrival that is at the gate and
 * LANDED_CONFIRMED one whose landing is confirmed and whose gate the provider
 * has named; both carry the same knowledge of where the plane is. LIVE,
 * COVERAGE_LOST, ON_GROUND and LANDED_INFERRED are not confirmed arrivals at a
 * gate and never qualify, and neither does a status with no gate ref.
 */
export function confirmedGate(pos: SelectedPosition | null, status: TrackStatus | null): string | null {
  if (!pos || !status || status.icao24 !== pos.icao24) return null;
  if (status.state !== "AT_GATE" && status.state !== "LANDED_CONFIRMED") return null;
  const gate = status.gate?.trim();
  return gate ? gate : null;
}

/**
 * Where to draw the selected plane instead of its last report, or null to
 * draw the report. Confirmed gate and either an old report or one on the
 * ground; `gatePoint` is where the gate resolved to — its own point, or a
 * terminal-area guess (null: not known, so nothing to move to).
 *
 * AT_GATE: a report well after the confirmed gate-in is the plane moving
 * again, and is drawn where it is.
 *
 * LANDED_CONFIRMED: `confirmedAt` is the touchdown time, not a gate-in, so a
 * report after it is the plane taxiing in, not a later movement. Only a stale
 * report is drawn at the gate; a fresh one is where the plane actually is.
 */
export function gateDisplay(pos: SelectedPosition | null, status: TrackStatus | null, nowMs: number, gatePoint: GatePoint | null): GateDisplay | null {
  const gate = confirmedGate(pos, status);
  if (!pos || !status || !gate || !gatePoint) return null;
  const observed = Date.parse(pos.observedAt);
  const stale = nowMs - observed > GATE_STALE_MS;
  if (status.state === "LANDED_CONFIRMED") {
    if (!stale) return null;
  } else {
    const gateIn = status.confirmedAt ? Date.parse(status.confirmedAt) : NaN;
    if (Number.isFinite(gateIn) && observed > gateIn + GATE_LATER_MOVEMENT_MS) return null;
    if (!stale && pos.onGround !== true) return null;
  }
  if (distanceM({ lat: status.lastSeenLat, lon: status.lastSeenLon }, gatePoint) > GATE_MAX_DISTANCE_M) return null;
  return { lat: gatePoint.lat, lon: gatePoint.lon, gate, approximate: gatePoint.approximate === true };
}

/**
 * The selected plane as the map draws it: at the gate with the gate in its
 * label, heading unknown there; else as reported. A guessed terminal-area
 * point says "Gate <ref>": the ref is the provider's, the point is not the
 * stand, and the marker should not claim it is.
 */
export function displayedPosition(pos: SelectedPosition, display: GateDisplay | null): SelectedPosition {
  if (!display) return pos;
  const callsign = pos.callsign?.trim() || pos.icao24.toUpperCase();
  const gate = display.approximate ? `Gate ${display.gate}` : display.gate;
  return { ...pos, latitude: display.lat, longitude: display.lon, headingDeg: null, callsign: `${callsign} · ${gate}` };
}

export interface TrailPoint {
  lat: number;
  lon: number;
  observedAt: string;
}

/**
 * The trail to draw, keeping each report's time. Real reports only, in time
 * order, none after the last observation. Normally it ends at the marker
 * (which can be a dead-reckoned estimate: a movable tip, carrying the
 * observedAt of the report it was projected from). When the plane is drawn at
 * its gate, the trail must not run on to the gate (that stretch was never
 * reported) and, if the last report is old, it is not drawn at all: it would
 * end away from the plane, at wherever coverage was lost. The times are what
 * lets the trail layer break the line across a real gap in the reports
 * (map/route.ts).
 */
export function trailPointsFor(
  points: TrailPoint[],
  tip: { latitude: number; longitude: number; observedAt: string } | null,
  display: GateDisplay | null,
  nowMs: number,
): TrailPoint[] {
  const until = tip ? Date.parse(tip.observedAt) : Infinity;
  const real = points
    .filter((pt) => Date.parse(pt.observedAt) <= until)
    .sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
  if (display) {
    const last = tip ? Date.parse(tip.observedAt) : NaN;
    return Number.isFinite(last) && nowMs - last > GATE_STALE_MS ? [] : real;
  }
  const out = real;
  const end = out[out.length - 1];
  if (tip && !(end && end.lat === tip.latitude && end.lon === tip.longitude)) {
    out.push({ lat: tip.latitude, lon: tip.longitude, observedAt: tip.observedAt });
  }
  return out;
}

/** The trail as [lat, lon] vertices, dropping the report times (see trailPointsFor). */
export function trailFor(
  points: TrailPoint[],
  tip: { latitude: number; longitude: number; observedAt: string } | null,
  display: GateDisplay | null,
  nowMs: number,
): [number, number][] {
  return trailPointsFor(points, tip, display, nowMs).map((p): [number, number] => [p.lat, p.lon]);
}

/** The first coordinate of a GeoJSON geometry as lat/lon: a gate is a point, but a mapped one may be an area. */
export function geometryPoint(geometry: { type: string; coordinates?: unknown } | null | undefined): LatLon | null {
  let c: unknown = geometry?.coordinates;
  while (Array.isArray(c) && Array.isArray(c[0])) c = c[0];
  if (!Array.isArray(c) || typeof c[0] !== "number" || typeof c[1] !== "number") return null;
  return { lat: c[1], lon: c[0] };
}
