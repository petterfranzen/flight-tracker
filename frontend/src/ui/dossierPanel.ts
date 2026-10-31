import type { AppStore } from "../state/appState";
import type { TrackStatus } from "../types/flight";
import { isAircraftFavorited, isRouteFavorited } from "../favorites";
import { h, clear } from "./h";

// Past this, "last updated" reads as a warning rather than routine network
// jitter.
const STALE_POSITION_WARN_MS = 10 * 60_000;

function formatAgo(observedAtIso: string, nowMs: number): string {
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
function staleSuffix(staleExplanation: string | null | undefined, status: TrackStatus | null): string {
  if (status && statusLabel(status)) return "";
  return ` — ${staleExplanation ?? "no recent updates"}`;
}

function formatDurationMinutes(totalMinutes: number): string {
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

function formatFlightPhase(phase: string | null | undefined): string {
  if (!phase) return "—";
  return FLIGHT_PHASE_LABELS[phase] ?? phase;
}

function formatAirport(name: string | null | undefined, icao: string | null | undefined, iata: string | null | undefined): string {
  const codes = [icao, iata].filter((c): c is string => Boolean(c)).join(" / ");
  if (name) return codes ? `${name} (${codes})` : name;
  return codes || "—";
}

// Wrapped in a div (valid inside <dl>) so the mobile sheet can lay fields out
// two to a row; on desktop the wrapper is `display: contents`, i.e. invisible.
// `wide` fields (long values like airport names) take a full row on mobile.
function field(dt: string, dd: string, wide = false): HTMLElement {
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

/** The dossier's status line for an aircraft that is not live; null when there is nothing to say (LIVE). */
export function statusLabel(status: TrackStatus): string | null {
  const runway = status.landing ? [status.landing.airportIcao, status.landing.runway].filter(Boolean).join(" ") : "";
  switch (status.state) {
    case "COVERAGE_LOST": {
      const estimate = status.estimate ? ` · est. ±${formatRadius(status.estimate.radiusM)}` : "";
      const landing = status.landing ? ` · landing ~${formatClockTime(status.landing.touchdownAt)} ${runway}` : "";
      return `Coverage lost${estimate}${landing}`;
    }
    case "LANDED_INFERRED":
      return `Landed${status.confidence != null ? ` ${Math.round(status.confidence * 100)}%` : ""} (inferred)${runway ? ` · ${runway}` : ""}`;
    case "ON_GROUND":
      return "On ground (ADS-B)";
    case "LANDED_CONFIRMED":
      return `Landed (confirmed · ${providerName(status.source)})`;
    case "AT_GATE": {
      const credit = creditedProvider(status);
      return `At gate${status.gate ? ` ${status.gate}` : ""} (confirmed${credit ? ` · ${credit.name}` : ""})`;
    }
    default:
      return null;
  }
}

/** The status line's element, or null when there is no status or the aircraft is live. */
function statusLine(status: TrackStatus | null): HTMLElement | null {
  const text = status && statusLabel(status);
  if (!status || !text) return null;
  // The credit is a real link: the provider's name inside the label becomes the anchor.
  const credit = creditedProvider(status);
  const at = credit ? text.lastIndexOf(credit.name) : -1;
  const content =
    credit && at >= 0
      ? [
          text.slice(0, at),
          h("a", { className: "details-panel-status-credit", href: credit.creditUrl, target: "_blank", rel: "noopener noreferrer" }, credit.name),
          text.slice(at + credit.name.length),
        ]
      : [text];
  return h(
    "p",
    { className: `details-panel-status details-panel-status--${status.sourceKind}`, "data-track-state": status.state, "data-source-kind": status.sourceKind },
    content,
  );
}

/**
 * Both the aircraft dossier and the airport dossier — mutually exclusive
 * (see main.ts's selectAircraft/selectAirport), same `.details-panel`
 * shell (desktop side panel / mobile bottom sheet).
 */
export function mount(root: HTMLElement, store: AppStore): () => void {
  // `nowMs` ticks every second while an aircraft is selected purely to
  // advance the "last updated" line — rebuilding the whole panel subtree
  // for that alone would drop DOM focus (e.g. a keyboard user tabbed to
  // Close) once a second, so it gets its own lightweight text-only path;
  // every other change (a new selection, dossier arriving, favorites,
  // expand/collapse, …) rebuilds the panel outright.
  let updatedLineEl: HTMLElement | null = null;

  function renderAll(): void {
    clear(root);
    updatedLineEl = null;
    const selectedPos = store.get("selectedPos");
    const airportDossier = store.get("airportDossier");
    if (selectedPos) {
      const built = renderAircraftPanel(store);
      updatedLineEl = built.updatedLine;
      root.appendChild(built.panel);
    } else if (airportDossier) {
      root.appendChild(renderAirportPanel(store));
    }
  }

  function updateNowMs(): void {
    if (!updatedLineEl) return;
    const selectedPos = store.get("selectedPos");
    if (!selectedPos) return;
    const nowMs = store.get("nowMs");
    const dossier = store.get("dossier");
    const status = store.get("trackStatus");
    const stale = nowMs - new Date(selectedPos.observedAt).getTime() > STALE_POSITION_WARN_MS;
    // Going stale changes how speed, climb and ETA read, not just this line.
    if (stale !== updatedLineEl.classList.contains("details-panel-updated--stale")) {
      renderAll();
      return;
    }
    updatedLineEl.className = `details-panel-updated${stale ? " details-panel-updated--stale" : ""}`;
    clear(updatedLineEl);
    updatedLineEl.append(
      stale ? "⚠ " : "",
      `Last updated ${formatAgo(selectedPos.observedAt, nowMs)}`,
      stale ? staleSuffix(dossier?.staleExplanation, status) : "",
    );
  }

  renderAll();
  const unsubscribeStructural = store.subscribeMany(
    ["selectedPos", "airportDossier", "dossier", "trackStatus", "dossierExpanded", "planeOffScreen", "airportInfo", "favoriteAircraft", "favoriteRoutes"],
    renderAll,
  );
  const unsubscribeNowMs = store.subscribe("nowMs", updateNowMs);

  return () => {
    unsubscribeStructural();
    unsubscribeNowMs();
    clear(root);
  };
}

function renderAircraftPanel(store: AppStore): { panel: HTMLElement; updatedLine: HTMLElement } {
  const selectedPos = store.get("selectedPos")!;
  const dossier = store.get("dossier");
  const dossierExpanded = store.get("dossierExpanded");
  const planeOffScreen = store.get("planeOffScreen");
  const nowMs = store.get("nowMs");
  const favoriteAircraft = store.get("favoriteAircraft");
  const favoriteRoutes = store.get("favoriteRoutes");
  const status = store.get("trackStatus");

  const aircraftFavorited = isAircraftFavorited(favoriteAircraft, selectedPos.icao24);
  const routeFavorited =
    dossier?.originAirport && dossier?.destinationAirport ? isRouteFavorited(favoriteRoutes, dossier.originAirport, dossier.destinationAirport) : false;
  const routeKnown = Boolean(dossier?.originAirport && dossier?.destinationAirport);
  const routeLabel = routeKnown ? `${dossier!.originAirportIata ?? dossier!.originAirport} → ${dossier!.destinationAirportIata ?? dossier!.destinationAirport}` : "";
  // Says what the two buttons do (and why "route" may be unavailable), since
  // a disabled button with only a hover title is a dead end on a phone.
  const favoriteHint = !routeKnown
    ? "Route unknown for this flight, so it can't be favorited yet"
    : routeFavorited
      ? `Saved: ${routeLabel} shows in Favorites when a flight is live`
      : `Favorite the route to see any live ${routeLabel} flight in Favorites`;
  const stale = nowMs - new Date(selectedPos.observedAt).getTime() > STALE_POSITION_WARN_MS;

  const heading = h("h2", null, selectedPos.callsign?.trim() || selectedPos.icao24.toUpperCase());

  const focusButton = planeOffScreen
    ? h(
        "button",
        { type: "button", className: "details-panel-focus-toggle", onClick: () => store.get("requestFocusPlane")() },
        "⌖ Focus Plane",
      )
    : null;

  const aircraftToggle = h(
    "button",
    {
      type: "button",
      className: `details-panel-favorite-toggle${aircraftFavorited ? " details-panel-favorite-toggle--active" : ""}`,
      onClick: () => store.get("toggleAircraftFavorite")(),
      "aria-pressed": String(aircraftFavorited),
      "aria-label": "Favorite this aircraft",
    },
    `${aircraftFavorited ? "★" : "☆"} Favorite aircraft`,
  );
  const routeToggle = h(
    "button",
    {
      type: "button",
      className: `details-panel-favorite-toggle${routeFavorited ? " details-panel-favorite-toggle--active" : ""}`,
      onClick: () => store.get("toggleRouteFavorite")(),
      disabled: !routeKnown,
      "aria-pressed": String(routeFavorited),
      "aria-label": "Favorite this route",
      title: routeKnown ? `Show any live ${routeLabel} flight in Favorites` : "Route not known for this aircraft yet",
    },
    `${routeFavorited ? "★" : "☆"} Favorite route`,
  );

  const updatedLine = h(
    "p",
    { className: `details-panel-updated${stale ? " details-panel-updated--stale" : ""}` },
    stale ? "⚠ " : "",
    `Last updated ${formatAgo(selectedPos.observedAt, nowMs)}`,
    stale ? staleSuffix(dossier?.staleExplanation, status) : "",
  );

  // Speed, climb and ETA describe a flight in progress. Once it has landed
  // (or sits on the ground with nothing heard for a while) the last airborne
  // values are history, not its state: "—". Stale but still flying, they are
  // shown as what they were at the last report.
  const landed = status?.state === "LANDED_INFERRED" || status?.state === "LANDED_CONFIRMED" || status?.state === "AT_GATE";
  const over = landed || (stale && Boolean(selectedPos.onGround));
  const motion = (text: string | null): string => (text == null || over ? "—" : stale ? `${text} (at last report)` : text);
  const onGround = over || Boolean(selectedPos.onGround) || status?.state === "ON_GROUND";

  const fields = h(
    "dl",
    { className: "details-panel-fields" },
    field("Type", dossier?.model || "—"),
    field("Registration", dossier?.registration || "—"),
    field("Operator", dossier?.operator || "—"),
    field("Origin", formatAirport(dossier?.originAirportName, dossier?.originAirport, dossier?.originAirportIata), true),
    field("Destination", formatAirport(dossier?.destinationAirportName, dossier?.destinationAirport, dossier?.destinationAirportIata), true),
    field("Phase", formatFlightPhase(dossier?.flightPhase)),
    // Clamped at 0: barometric altitude reads a few meters negative on the
    // ground fairly often (sensor noise), and "-23 m" for a parked
    // aircraft reads as a bug, not as a precision artifact.
    field("Altitude", selectedPos.altitudeM != null ? `${Math.round(Math.max(0, selectedPos.altitudeM))} m` : "—"),
    // Never below zero: that's a barometric reading on a high-pressure day, not a cruise.
    field("Cruising altitude", dossier?.cruisingAltitudeM != null && dossier.cruisingAltitudeM > 0 ? `${Math.round(dossier.cruisingAltitudeM)} m` : "—"),
    field("Speed", motion(selectedPos.velocityMs != null ? `${Math.round(selectedPos.velocityMs * 3.6)} km/h` : null)),
    // Signed, not just magnitude: the sign is the only thing that says
    // climbing vs. descending. Level flight reads "+0.0 m/s", not a bare 0.
    field("Vertical rate", motion(selectedPos.verticalRateMs != null ? formatVerticalRate(selectedPos.verticalRateMs) : null)),
    field("Flight time", dossier?.flightMinutes != null ? formatDurationMinutes(dossier.flightMinutes) : "—"),
    field("ETA", onGround ? "—" : motion(dossier?.etaMinutes != null ? formatDurationMinutes(dossier.etaMinutes) : null)),
  );

  const panel = h(
    "aside",
    { className: `details-panel${dossierExpanded ? " details-panel--expanded" : ""}`, "aria-labelledby": "details-panel-heading" },
    h(
      "button",
      { className: "details-panel-close-x", onClick: () => store.get("closeAircraftPanel")(), "aria-label": "Close aircraft details" },
      "✕",
    ),
    h(
      "div",
      { className: "details-panel-inner" },
      h(
        "button",
        {
          className: "details-panel-expand-toggle",
          onClick: () => store.get("toggleDossierExpanded")(),
          "aria-expanded": String(dossierExpanded),
          "aria-label": dossierExpanded ? "Show less" : "Show more",
        },
        dossierExpanded ? "▼" : "▲",
      ),
      h("span", { className: "details-panel-eyebrow", id: "details-panel-heading" }, "Aircraft Details"),
      heading,
      focusButton,
      h("div", { className: "details-panel-favorite-toggles" }, aircraftToggle, routeToggle),
      h("p", { className: "details-panel-favorite-hint" }, favoriteHint),
      h("p", { className: "details-panel-meta details-panel-meta--secondary" }, `ICAO24 ${selectedPos.icao24.toUpperCase()} · last leg traced above`),
      updatedLine,
      statusLine(status),
      fields,
      h("button", { className: "details-panel-close", onClick: () => store.get("closeAircraftPanel")(), "aria-label": "Close aircraft details" }, "Close"),
    ),
  );
  return { panel, updatedLine };
}

function renderAirportPanel(store: AppStore): HTMLElement {
  const airportDossier = store.get("airportDossier")!;
  const airportInfo = store.get("airportInfo");
  const dossierExpanded = store.get("dossierExpanded");

  const fields = h(
    "dl",
    { className: "details-panel-fields" },
    field("Municipality", airportInfo?.municipality || "—"),
    field("Country", airportInfo?.country || "—"),
    field("Latitude", `${airportDossier.lat.toFixed(4)}°`),
    field("Longitude", `${airportDossier.lon.toFixed(4)}°`),
  );

  return h(
    "aside",
    { className: `details-panel${dossierExpanded ? " details-panel--expanded" : ""}`, "aria-labelledby": "airport-details-panel-heading" },
    h(
      "button",
      { className: "details-panel-close-x", onClick: () => store.get("closeAirportPanel")(), "aria-label": "Close airport details" },
      "✕",
    ),
    h(
      "div",
      { className: "details-panel-inner" },
      h(
        "button",
        {
          className: "details-panel-expand-toggle",
          onClick: () => store.get("toggleDossierExpanded")(),
          "aria-expanded": String(dossierExpanded),
          "aria-label": dossierExpanded ? "Show less" : "Show more",
        },
        dossierExpanded ? "▼" : "▲",
      ),
      h("span", { className: "details-panel-eyebrow", id: "airport-details-panel-heading" }, "Airport Details"),
      h("h2", null, airportDossier.name || airportDossier.code),
      h("p", { className: "details-panel-meta" }, `${airportInfo?.iataCode || airportDossier.code}${airportInfo?.icaoCode ? ` / ${airportInfo.icaoCode}` : ""}`),
      fields,
      h("button", { className: "details-panel-close", onClick: () => store.get("closeAirportPanel")(), "aria-label": "Close airport details" }, "Close"),
    ),
  );
}

function formatVerticalRate(ms: number): string {
  const rounded = Math.round(ms * 10) / 10;
  // Normalise -0 (e.g. -0.04 rounds to -0) so level flight reads "+0.0".
  const value = rounded === 0 ? 0 : rounded;
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)} m/s`;
}
