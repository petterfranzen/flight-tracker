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

function main(): void {
  const world = new World();
  const t0 = world.t0;
  const times = Array.from({ length: TICK_COUNT }, (_, i) => t0 + i * TICK_MS);
  const inside = (lat: number, lon: number): boolean =>
    lat >= RECORD_BBOX.latMin && lat <= RECORD_BBOX.latMax && lon >= RECORD_BBOX.lonMin && lon <= RECORD_BBOX.lonMax;

  // Every aircraft that is inside the recorded region at any tick.
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

  const inFleet = new Set(fleet.map((f) => f.icao24));
  // Positions only; each tick's time is recordedAtMs + i * tickMs (meta).
  const ticks = times.map((t) => {
    const lat: number[] = [];
    const lon: number[] = [];
    for (const a of world.aircraft) {
      if (!inFleet.has(a.icao24)) continue;
      const p = world.positionAt(a, t);
      lat.push(round(p.lat, 4));
      lon.push(round(p.lon, 4));
    }
    return { lat, lon };
  });

  // Candidate planes for the "select a plane" scenario: the fleet nearest the
  // map's default centre at the start, so they are the ones on screen there.
  const centre = { lat: 59.33, lon: 18.06 };
  const candidates = fleet
    .map((f) => ({ f, d: Math.hypot(world.get(f.icao24)!.lat0 - centre.lat, world.get(f.icao24)!.lon0 - centre.lon) }))
    .sort((x, y) => x.d - y.d)
    .slice(0, HISTORY_CANDIDATES)
    .map((x) => x.f.icao24);

  const history: Record<string, { t: number; lat: number; lon: number }[]> = {};
  for (const icao of candidates) {
    const a = world.get(icao)!;
    const points: { t: number; lat: number; lon: number }[] = [];
    for (let s = HISTORY_S; s >= 0; s -= HISTORY_STEP_S) {
      const p = world.positionAt(a, t0 - s * 1000);
      points.push({ t: t0 - s * 1000, lat: round(p.lat, 4), lon: round(p.lon, 4) });
    }
    for (let i = 0; i < TICK_COUNT; i++) {
      const p = world.positionAt(a, times[i]);
      points.push({ t: times[i], lat: round(p.lat, 4), lon: round(p.lon, 4) });
    }
    history[icao] = points;
  }

  // /api/flights/{icao24}/status samples: a plain live track (no estimate), so
  // the marker is never moved by the status — the trail/marker checks are
  // about the /live and WebSocket data only.
  const status: Record<string, unknown[]> = {};
  for (const icao of candidates) {
    const a = world.get(icao)!;
    status[icao] = times
      .filter((_, i) => i % STATUS_SAMPLE_EVERY === 0)
      .map((t) => {
        const p = world.positionAt(a, t);
        return {
          icao24: icao,
          state: "LIVE",
          confidence: null,
          source: "adsb",
          sourceKind: "observed",
          lastSeenAt: new Date(t).toISOString(),
          lastSeenLat: round(p.lat, 4),
          lastSeenLon: round(p.lon, 4),
          estimate: null,
          landing: null,
          gate: null,
          terminal: null,
          confirmedAt: null,
        };
      });
  }

  const recording = {
    meta: {
      version: 1,
      source: "scenario World (tests/scenarios/world.ts): a deterministic, OpenSky-shaped fleet around Stockholm",
      recordedAt: new Date(t0).toISOString(),
      recordedAtMs: t0,
      tickMs: TICK_MS,
      tickCount: TICK_COUNT,
      bbox: RECORD_BBOX,
      zooms: RECORD_ZOOMS,
      wsNote: "WebSocket frames are the same recorded positions, one LiveFrame per aircraft per tick, filtered to the viewport the app last reported — the replay derives them (see docs/popping-harness.md).",
    },
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
