/**
 * Records the fixture set the popping harness (tests/popping.spec.ts) replays.
 *
 * Source of "production-like data": the scenario suite's simulated world
 * (tests/scenarios/world.ts) — a deterministic OpenSky-shaped fleet of ~230
 * airliners flying real headings out of Arlanda, Schiphol and Kalmar, which
 * every existing scenario already treats as the backend. We have no route to
 * the live backend from an agent sandbox, so the world stands in for it; the
 * recorded shapes are the server's own (see backend/.../FlightController and
 * LiveMarker.java). Public ADS-B, so nothing here is sensitive.
 *
 * What is recorded, per tick (2 s, 3 minutes — a few minutes, small files):
 *   - the fleet roster once (identity + the marker fields /live carries),
 *   - every aircraft's position at each tick: what /api/flights/live returns
 *     for the Stockholm bbox, what /api/flights/live/overview thins out of it
 *     at zooms 6..10, and the WebSocket frames (one LiveFrame per aircraft per
 *     tick — the replay derives them from these same positions; see
 *     docs/popping-harness.md),
 *   - /api/flights/{icao24}/status samples for the candidate planes, and a
 *     40-minute history per candidate.
 *
 * Run it with:
 *   node --experimental-strip-types scripts/record-popping-fixtures.ts
 * (Node 24 strips the types itself; no build step.)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { World } from "../tests/scenarios/world.ts";

export const TICK_MS = 2_000;
export const TICK_COUNT = 90; // 3 minutes
/** The Stockholm region the gesture scenarios roam; also what the opening view picks from. */
export const RECORD_BBOX = { latMin: 55, latMax: 62, lonMin: 13, lonMax: 22 };
export const RECORD_ZOOMS = [6, 7, 8, 9, 10];
const HISTORY_S = 40 * 60;
const HISTORY_STEP_S = 60;
const HISTORY_CANDIDATES = 8;
const STATUS_SAMPLE_EVERY = 10;

const round = (v: number, dp: number): number => Number(v.toFixed(dp));

interface RecFleet {
  icao24: string;
  callsign: string;
  altitudeM: number;
  velocityMs: number;
  headingDeg: number;
  agentSource: string;
  onGround: boolean;
}

type SimAircraft = World["aircraft"][number];
type HistoryPoint = { t: number; lat: number; lon: number };

const inside = (lat: number, lon: number): boolean =>
  lat >= RECORD_BBOX.latMin && lat <= RECORD_BBOX.latMax && lon >= RECORD_BBOX.lonMin && lon <= RECORD_BBOX.lonMax;

/** A position rounded to the 4 dp the fixtures store. */
function roundedAt(world: World, a: SimAircraft, t: number): { lat: number; lon: number } {
  const p = world.positionAt(a, t);
  return { lat: round(p.lat, 4), lon: round(p.lon, 4) };
}

/** Every aircraft that is inside the recorded region at any tick. */
function recordFleet(world: World, times: number[]): RecFleet[] {
  const fleet: RecFleet[] = [];
  for (const a of world.aircraft) {
    if (!times.some((t) => { const p = world.positionAt(a, t); return inside(p.lat, p.lon); })) continue;
    fleet.push({
      icao24: a.icao24,
      callsign: a.callsign,
      altitudeM: a.altitudeM,
      velocityMs: 245,
      headingDeg: a.headingDeg,
      agentSource: "opensky",
      onGround: false,
    });
  }
  return fleet;
}

/** Positions only; each tick's time is recordedAtMs + i * tickMs (meta). */
function recordTicks(world: World, times: number[], fleet: RecFleet[]): { lat: number[]; lon: number[] }[] {
  const inFleet = new Set(fleet.map((f) => f.icao24));
  const members = world.aircraft.filter((a) => inFleet.has(a.icao24));
  return times.map((t) => {
    const lat: number[] = [];
    const lon: number[] = [];
    for (const a of members) {
      const p = roundedAt(world, a, t);
      lat.push(p.lat);
      lon.push(p.lon);
    }
    return { lat, lon };
  });
}

/**
 * Candidate planes for the "select a plane" scenario: the fleet nearest the
 * map's default centre at the start, so they are the ones on screen there.
 */
function pickCandidates(world: World, fleet: RecFleet[]): string[] {
  const centre = { lat: 59.33, lon: 18.06 };
  return fleet
    .map((f) => ({ f, d: Math.hypot(world.get(f.icao24)!.lat0 - centre.lat, world.get(f.icao24)!.lon0 - centre.lon) }))
    .sort((x, y) => x.d - y.d)
    .slice(0, HISTORY_CANDIDATES)
    .map((x) => x.f.icao24);
}

/** A 40-minute history before t0, then every recorded tick. */
function historyFor(world: World, a: SimAircraft, times: number[]): HistoryPoint[] {
  const t0 = world.t0;
  const points: HistoryPoint[] = [];
  for (let s = HISTORY_S; s >= 0; s -= HISTORY_STEP_S) {
    points.push({ t: t0 - s * 1000, ...roundedAt(world, a, t0 - s * 1000) });
  }
  for (const t of times) {
    points.push({ t, ...roundedAt(world, a, t) });
  }
  return points;
}

/**
 * /api/flights/{icao24}/status samples: a plain live track (no estimate), so
 * the marker is never moved by the status — the trail/marker checks are
 * about the /live and WebSocket data only.
 */
function statusSamples(world: World, icao: string, times: number[]): unknown[] {
  const a = world.get(icao)!;
  return times
    .filter((_, i) => i % STATUS_SAMPLE_EVERY === 0)
    .map((t) => {
      const p = roundedAt(world, a, t);
      return {
        icao24: icao,
        state: "LIVE",
        confidence: null,
        source: "adsb",
        sourceKind: "observed",
        lastSeenAt: new Date(t).toISOString(),
        lastSeenLat: p.lat,
        lastSeenLon: p.lon,
        estimate: null,
        landing: null,
        gate: null,
        terminal: null,
        confirmedAt: null,
      };
    });
}

function recordingMeta(t0: number) {
  return {
    version: 1,
    source: "scenario World (tests/scenarios/world.ts): a deterministic, OpenSky-shaped fleet around Stockholm",
    recordedAt: new Date(t0).toISOString(),
    recordedAtMs: t0,
    tickMs: TICK_MS,
    tickCount: TICK_COUNT,
    bbox: RECORD_BBOX,
    zooms: RECORD_ZOOMS,
    wsNote: "WebSocket frames are the same recorded positions, one LiveFrame per aircraft per tick, filtered to the viewport the app last reported — the replay derives them (see docs/popping-harness.md).",
  };
}

function main(): void {
  const world = new World();
  const t0 = world.t0;
  const times = Array.from({ length: TICK_COUNT }, (_, i) => t0 + i * TICK_MS);
  const fleet = recordFleet(world, times);
  const ticks = recordTicks(world, times, fleet);
  const candidates = pickCandidates(world, fleet);

  const history: Record<string, HistoryPoint[]> = {};
  const status: Record<string, unknown[]> = {};
  for (const icao of candidates) {
    history[icao] = historyFor(world, world.get(icao)!, times);
    status[icao] = statusSamples(world, icao, times);
  }

  const recording = {
    meta: recordingMeta(t0),
    fleet,
    ticks,
    selected: { candidates, history, status },
  };

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(recording));
  const bytes = JSON.stringify(recording).length;
  console.log(`wrote ${OUT}`);
  console.log(`fleet ${fleet.length}, ticks ${ticks.length}, candidates ${candidates.length}, ${(bytes / 1024).toFixed(0)} KiB`);
}

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "../tests/fixtures/popping/recording.json");

main();
