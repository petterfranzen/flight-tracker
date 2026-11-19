import type { AircraftDossier, SelectedPosition, TrackStatus } from "../types/flight";
import { h, clear } from "./h";

/** Formatting and the status line for dossierPanel.ts: no store, no panel state. */

// Past this, "last updated" reads as a warning rather than routine network
// jitter.
export const STALE_POSITION_WARN_MS = 10 * 60_000;

export function formatAgo(observedAtIso: string, nowMs: number): string {
  const elapsedMs = Math.max(0, nowMs - new Date(observedAtIso).getTime());
  const seconds = Math.round(elapsedMs / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return `${hours}h ago`;
}

// With a status line shown, the guess at what the silent aircraft is doing is the status's job.
export function staleSuffix(staleExplanation: string | null | undefined, status: TrackStatus | null): string {
  if (status && statusLabel(status)) return "";
  return ` — ${staleExplanation ?? "no recent updates"}`;
}

export function formatDurationMinutes(totalMinutes: number): string {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

const FLIGHT_PHASE_LABELS: Record<string, string> = {
  ON_GROUND: "On ground",
  TAKING_OFF: "Taking off",
  CLIMBING: "Climbing",
  LEVEL: "Level",
  DESCENDING: "Descending",
  LANDING: "Landing",
};

export function formatFlightPhase(phase: string | null | undefined): string {
  if (!phase) return "—";
  return FLIGHT_PHASE_LABELS[phase] ?? phase;
}

export function formatAirport(name: string | null | undefined, icao: string | null | undefined, iata: string | null | undefined): string {
  const codes = [icao, iata].filter((c): c is string => Boolean(c)).join(" / ");
  if (name) return codes ? `${name} (${codes})` : name;
  return codes || "—";
}

// Wrapped in a div (valid inside <dl>) so the mobile sheet can lay fields out
// two to a row; on desktop the wrapper is `display: contents`, i.e. invisible.
// `wide` fields (long values like airport names) take a full row on mobile.
export function field(dt: string, dd: string, wide = false): HTMLElement {
  return h("div", { className: `details-panel-field${wide ? " details-panel-field--wide" : ""}` }, h("dt", null, dt), h("dd", null, dd));
}

function formatClockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

function formatRadius(radiusM: number): string {
  // Same steps as the backend's status label: 10 m under 1 km, one decimal under 10 km, whole km above.
  if (radiusM < 1000) return `${Math.round(radiusM / 10) * 10} m`;
  return radiusM < 10_000 ? `${(radiusM / 1000).toFixed(1)} km` : `${Math.round(radiusM / 1000)} km`;
}

interface ProviderDisplay {
  name: string;
  /** Set when the provider's terms require a visible credit that links here. */
  creditUrl?: string;
}

// Readable provider names for the confirmed status. AeroDataBox's free plan requires a visible credit linking to
// its site (terms 5.4); Swedavia states no such requirement. An unknown id is shown as it is.
const PROVIDERS: Record<string, ProviderDisplay> = {
  aerodatabox: { name: "AeroDataBox", creditUrl: "https://aerodatabox.com" },
  swedavia: { name: "Swedavia" },
};

function providerName(source: string): string {
  return PROVIDERS[source]?.name ?? source;
}

/** The provider to credit on this status, or null when its terms ask for none. */
function creditedProvider(status: TrackStatus): ProviderDisplay | null {
  if (status.sourceKind !== "confirmed") return null;
  const provider = PROVIDERS[status.source];
  return provider?.creditUrl ? provider : null;
}

const landingRunway = (status: TrackStatus): string =>
  status.landing ? [status.landing.airportIcao, status.landing.runway].filter(Boolean).join(" ") : "";

function coverageLostLabel(status: TrackStatus): string {
  const estimate = status.estimate ? ` · est. ±${formatRadius(status.estimate.radiusM)}` : "";
  const landing = status.landing ? ` · landing ~${formatClockTime(status.landing.touchdownAt)} ${landingRunway(status)}` : "";
  return `Coverage lost${estimate}${landing}`;
}

function landedInferredLabel(status: TrackStatus): string {
  const runway = landingRunway(status);
  const confidence = status.confidence != null ? ` ${Math.round(status.confidence * 100)}%` : "";
  return `Landed${confidence} (inferred)${runway ? ` · ${runway}` : ""}`;
}

function atGateLabel(status: TrackStatus, approximate: boolean): string {
  const credit = creditedProvider(status);
  // A guess is not the gate: say so on the line that names it.
  const approx = approximate ? " · approx. position" : "";
  return `At gate${status.gate ? ` ${status.gate}` : ""} (confirmed${credit ? ` · ${credit.name}` : ""}${approx})`;
}

const STATUS_LABELS: Partial<Record<TrackStatus["state"], (status: TrackStatus, approximate: boolean) => string>> = {
  COVERAGE_LOST: coverageLostLabel,
  LANDED_INFERRED: landedInferredLabel,
  ON_GROUND: () => "On ground (ADS-B)",
  LANDED_CONFIRMED: (status) => `Landed (confirmed · ${providerName(status.source)})`,
  AT_GATE: atGateLabel,
};

/** The dossier's status line for an aircraft that is not live; null when there is nothing to say (LIVE). */
export function statusLabel(status: TrackStatus, approximate = false): string | null {
  return STATUS_LABELS[status.state]?.(status, approximate) ?? null;
}

/** The label's text with the credited provider's name turned into a link to its site. */
function creditedContent(text: string, status: TrackStatus): (string | HTMLElement)[] {
  // The credit is a real link: the provider's name inside the label becomes the anchor.
  const credit = creditedProvider(status);
  const at = credit ? text.lastIndexOf(credit.name) : -1;
  if (!credit || at < 0) return [text];
  return [
    text.slice(0, at),
    h("a", { className: "details-panel-status-credit", href: credit.creditUrl, target: "_blank", rel: "noopener noreferrer" }, credit.name),
    text.slice(at + credit.name.length),
  ];
}

/** The status line's element, or null when there is no status or the aircraft is live. */
export function statusLine(status: TrackStatus | null, approximate = false): HTMLElement | null {
  const text = status && statusLabel(status, approximate);
  if (!status || !text) return null;
  return h(
    "p",
    { className: `details-panel-status details-panel-status--${status.sourceKind}`, "data-track-state": status.state, "data-source-kind": status.sourceKind },
    creditedContent(text, status),
  );
}

export function isStale(observedAtIso: string, nowMs: number): boolean {
  return nowMs - new Date(observedAtIso).getTime() > STALE_POSITION_WARN_MS;
}

export interface UpdatedLineInput {
  observedAt: string;
  nowMs: number;
  staleExplanation: string | null | undefined;
  status: TrackStatus | null;
}

/** (Re)writes the "Last updated …" line, with the stale warning past STALE_POSITION_WARN_MS. */
export function writeUpdatedLine(el: HTMLElement, { observedAt, nowMs, staleExplanation, status }: UpdatedLineInput): void {
  const stale = isStale(observedAt, nowMs);
  el.className = `details-panel-updated${stale ? " details-panel-updated--stale" : ""}`;
  clear(el);
  el.append(stale ? "⚠ " : "", `Last updated ${formatAgo(observedAt, nowMs)}`, stale ? staleSuffix(staleExplanation, status) : "");
}

export function formatVerticalRate(ms: number): string {
  const rounded = Math.round(ms * 10) / 10;
  // Normalise -0 (e.g. -0.04 rounds to -0) so level flight reads "+0.0".
  const value = rounded === 0 ? 0 : rounded;
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)} m/s`;
}

const LANDED_STATES = new Set<TrackStatus["state"]>(["LANDED_INFERRED", "LANDED_CONFIRMED", "AT_GATE"]);

interface FieldContext {
  pos: SelectedPosition;
  dossier: AircraftDossier | null;
  /** The flight has landed, or sat on the ground with nothing heard for a while. */
  over: boolean;
  stale: boolean;
  onGround: boolean;
}

// Speed, climb and ETA describe a flight in progress. Once it has landed
// (or sits on the ground with nothing heard for a while) the last airborne
// values are history, not its state: "—". Stale but still flying, they are
// shown as what they were at the last report.
export function fieldContext(pos: SelectedPosition, dossier: AircraftDossier | null, status: TrackStatus | null, stale: boolean): FieldContext {
  const landed = status != null && LANDED_STATES.has(status.state);
  const over = landed || (stale && Boolean(pos.onGround));
  const onGround = over || Boolean(pos.onGround) || status?.state === "ON_GROUND";
  return { pos, dossier, over, stale, onGround };
}

function motion(ctx: FieldContext, text: string | null): string {
  if (text == null || ctx.over) return "—";
  return ctx.stale ? `${text} (at last report)` : text;
}

const orDash = <T>(value: T | null | undefined, format: (v: T) => string): string => (value != null ? format(value) : "—");

interface FieldSpec {
  label: string;
  value: (ctx: FieldContext) => string;
  wide?: boolean;
}

const AIRCRAFT_FIELDS: FieldSpec[] = [
  { label: "Type", value: ({ dossier }) => dossier?.model || "—" },
  { label: "Registration", value: ({ dossier }) => dossier?.registration || "—" },
  { label: "Operator", value: ({ dossier }) => dossier?.operator || "—" },
  { label: "Origin", wide: true, value: ({ dossier }) => formatAirport(dossier?.originAirportName, dossier?.originAirport, dossier?.originAirportIata) },
  {
    label: "Destination",
    wide: true,
    value: ({ dossier }) => formatAirport(dossier?.destinationAirportName, dossier?.destinationAirport, dossier?.destinationAirportIata),
  },
  { label: "Phase", value: ({ dossier }) => formatFlightPhase(dossier?.flightPhase) },
  // Clamped at 0: barometric altitude reads a few meters negative on the
  // ground fairly often (sensor noise), and "-23 m" for a parked
  // aircraft reads as a bug, not as a precision artifact.
  { label: "Altitude", value: ({ pos }) => orDash(pos.altitudeM, (m) => `${Math.round(Math.max(0, m))} m`) },
  // Never below zero: that's a barometric reading on a high-pressure day, not a cruise.
  { label: "Cruising altitude", value: ({ dossier }) => orDash(dossier?.cruisingAltitudeM, (m) => (m > 0 ? `${Math.round(m)} m` : "—")) },
  { label: "Speed", value: (ctx) => motion(ctx, orNull(ctx.pos.velocityMs, (v) => `${Math.round(v * 3.6)} km/h`)) },
  // Signed, not just magnitude: the sign is the only thing that says
  // climbing vs. descending. Level flight reads "+0.0 m/s", not a bare 0.
  { label: "Vertical rate", value: (ctx) => motion(ctx, orNull(ctx.pos.verticalRateMs, formatVerticalRate)) },
  { label: "Flight time", value: ({ dossier }) => orDash(dossier?.flightMinutes, formatDurationMinutes) },
  { label: "ETA", value: (ctx) => (ctx.onGround ? "—" : motion(ctx, orNull(ctx.dossier?.etaMinutes, formatDurationMinutes))) },
];

function orNull<T>(value: T | null | undefined, format: (v: T) => string): string | null {
  return value != null ? format(value) : null;
}

export function aircraftFields(ctx: FieldContext): HTMLElement {
  return h("dl", { className: "details-panel-fields" }, AIRCRAFT_FIELDS.map((f) => field(f.label, f.value(ctx), f.wide)));
}
