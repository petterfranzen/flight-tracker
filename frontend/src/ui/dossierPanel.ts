import type { AppStore } from "../state/appState";
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
    const stale = nowMs - new Date(selectedPos.observedAt).getTime() > STALE_POSITION_WARN_MS;
    updatedLineEl.className = `details-panel-updated${stale ? " details-panel-updated--stale" : ""}`;
    clear(updatedLineEl);
    updatedLineEl.append(
      stale ? "⚠ " : "",
      `Last updated ${formatAgo(selectedPos.observedAt, nowMs)}`,
      stale ? ` — ${dossier?.staleExplanation ?? "no recent updates"}` : "",
    );
  }

  renderAll();
  const unsubscribeStructural = store.subscribeMany(
    ["selectedPos", "airportDossier", "dossier", "dossierExpanded", "planeOffScreen", "airportInfo", "favoriteAircraft", "favoriteRoutes"],
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
    stale ? ` — ${dossier?.staleExplanation ?? "no recent updates"}` : "",
  );

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
    field("Cruising altitude", dossier?.cruisingAltitudeM != null ? `${Math.round(dossier.cruisingAltitudeM)} m` : "—"),
    field("Speed", selectedPos.velocityMs != null ? `${Math.round(selectedPos.velocityMs * 3.6)} km/h` : "—"),
    // Signed, not just magnitude: the sign is the only thing that says
    // climbing vs. descending. Level flight reads "+0.0 m/s", not a bare 0.
    field("Vertical rate", selectedPos.verticalRateMs != null ? formatVerticalRate(selectedPos.verticalRateMs) : "—"),
    field("Flight time", dossier?.flightMinutes != null ? formatDurationMinutes(dossier.flightMinutes) : "—"),
    field("ETA", dossier?.etaMinutes != null ? formatDurationMinutes(dossier.etaMinutes) : "—"),
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
