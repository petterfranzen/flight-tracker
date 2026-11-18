import type { Bounds, FlightPosition, LiveMarker, LiveOverview } from "../types/flight";
import { newerReport, sameReport } from "./reportOrder";

export function padBounds(b: Bounds, fraction: number): Bounds {
  const dLat = (b.latMax - b.latMin) * fraction;
  const dLon = (b.lonMax - b.lonMin) * fraction;
  return { latMin: b.latMin - dLat, latMax: b.latMax + dLat, lonMin: b.lonMin - dLon, lonMax: b.lonMax + dLon };
}

export function inBounds(b: Bounds, lat: number, lon: number): boolean {
  return lat >= b.latMin && lat <= b.latMax && lon >= b.lonMin && lon <= b.lonMax;
}

/**
 * A drawn position carries the time its information was produced, `asOf`: a
 * viewport snapshot's fetch time, a WebSocket push's arrival, or — for the
 * selected plane — its estimate's own time.
 *
 * `observedAt` alone cannot order positions. The server serves each plane's
 * dead-reckoned position, so two snapshots of the same last report share
 * `observedAt` with *different* positions, the older snapshot's several
 * seconds behind. Comparing `observedAt` strictly therefore let a cached view
 * drawn during a pan/zoom overwrite the fresher position already on screen:
 * the marker popped backwards along its track and forward again when the
 * response landed (#53 / #97). `asOf` orders them, so a position older than
 * the one drawn never replaces it.
 */
export interface AsOfMarker extends LiveMarker {
  asOf: number;
}

/** The overview payload as its view cache holds it: every plane stamped. */
export interface AsOfOverview extends Omit<LiveOverview, "planes"> {
  planes: AsOfMarker[];
}

/** A snapshot's markers, stamped with the time it was fetched. */
export function stamp(list: LiveMarker[], asOf: number): AsOfMarker[] {
  return list.map((p) => ({ ...p, asOf }));
}

/**
 * Whether `incoming` sits further along the aircraft's own track than `existing`
 * (the sign of the displacement along `existing`'s heading).
 */
export function aheadOf(existing: LiveMarker, incoming: LiveMarker): boolean {
  const heading = ((existing.headingDeg ?? incoming.headingDeg ?? 0) * Math.PI) / 180;
  const dx = incoming.longitude - existing.longitude;
  const dy = incoming.latitude - existing.latitude;
  return dx * Math.sin(heading) + dy * Math.cos(heading) > 0;
}

/**
 * The position to draw, given what is already drawn and what a payload says.
 *
 * `asOf` (the time the information was produced) orders payloads of the same
 * report taken at different times, and on a tie the drawn one is kept. But two
 * payloads of the *same report* (`observedAt` naming the same instant, however
 * it is spelled) sit at different points along the track: a snapshot is the
 * report dead-reckoned forward, a raw report is the report itself. For the same
 * report the further-along position is the later information, so it wins and
 * the marker never moves backwards (#150).
 */
export function newerOf(existing: AsOfMarker | undefined, incoming: AsOfMarker): AsOfMarker {
  if (!existing) return incoming;
  if (sameReport(existing.observedAt, incoming.observedAt)) return aheadOf(existing, incoming) ? incoming : existing;
  return existing.asOf >= incoming.asOf ? existing : incoming;
}

/**
 * Whether a WebSocket frame should move a marker that is already drawn.
 *
 * A LiveFrame carries the aircraft's **raw** last report (LiveFrame.of in the
 * backend, straight off the persisted position), while `/live` and
 * `/live/overview` serve the server's **dead-reckoned** display position: the
 * same report projected forward along its own track by
 * EstimatedPositionService (up to `speed x report age`, and the estimate is
 * refreshed on its own cycle). The two payloads of the *same* report therefore
 * share `observedAt` with positions several km apart.
 *
 * So a frame only moves a marker when it carries a report **strictly newer**
 * than the one already drawn. For the same report the drawn position - a
 * snapshot's dead-reckoned estimate - stands: it is the more current answer to
 * "where is the aircraft now". Applying the frame instead pulled the marker
 * back to the raw report, and the next refresh snapped it forward again: the
 * idle reversion of #150, where frame and refresh disagreed about the same
 * report and each redraw took the other's side.
 *
 * Both comparisons go through `Date.parse` (map/reportOrder.ts): `observedAt`
 * can arrive spelled with an offset, or with or without fractional seconds, and
 * ordering the strings would put two reports in the wrong order.
 *
 * A genuinely new report has a newer `observedAt`, so it still moves the marker
 * immediately.
 */
export function frameAdvances(existing: LiveMarker | undefined, p: FlightPosition): boolean {
  return existing === undefined || newerReport(p.observedAt, existing.observedAt);
}
