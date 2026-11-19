import type { AppStore } from "../state/appState";
import type { AircraftDossier, SelectedPosition } from "../types/flight";
import { isAircraftFavorited, isRouteFavorited } from "../favorites";
import { h, clear, type Child } from "./h";
import { closeOnEscape, modalOpen } from "./a11y";
import {
  aircraftFields,
  field,
  fieldContext,
  isStale,
  statusLine,
  writeUpdatedLine,
  type UpdatedLineInput,
} from "./dossierFormat";

export { statusLabel } from "./dossierFormat";

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
    const stale = isStale(selectedPos.observedAt, nowMs);
    // Going stale changes how speed, climb and ETA read, not just this line.
    if (stale !== updatedLineEl.classList.contains("details-panel-updated--stale")) {
      renderAll();
      return;
    }
    writeUpdatedLine(updatedLineEl, updatedLineInput(store, selectedPos));
  }

  // Escape closes the open dossier. Skips while a modal overlay is open (the
  // phone drawers, the resume dialog), so one keypress closes one thing.
  const detachEscape = closeOnEscape(() => {
    if (modalOpen()) return;
    if (store.get("selectedPos")) store.get("closeAircraftPanel")();
    else if (store.get("airportDossier")) store.get("closeAirportPanel")();
  });

  renderAll();
  const unsubscribeStructural = store.subscribeMany(
    ["selectedPos", "airportDossier", "dossier", "trackStatus", "gateApproximate", "dossierExpanded", "planeOffScreen", "airportInfo", "favoriteAircraft", "favoriteRoutes"],
    renderAll,
  );
  const unsubscribeNowMs = store.subscribe("nowMs", updateNowMs);

  return () => {
    unsubscribeStructural();
    unsubscribeNowMs();
    detachEscape();
    clear(root);
  };
}

function updatedLineInput(store: AppStore, selectedPos: SelectedPosition): UpdatedLineInput {
  return {
    observedAt: selectedPos.observedAt,
    nowMs: store.get("nowMs"),
    staleExplanation: store.get("dossier")?.staleExplanation,
    status: store.get("trackStatus"),
  };
}

interface ShellOptions {
  store: AppStore;
  /** "aircraft" or "airport": names the close action, the labels and the heading id. */
  kind: "aircraft" | "airport";
  headingId: string;
  eyebrow: string;
  body: Child[];
}

/** The `.details-panel` shell both dossiers share: close ✕, expand toggle, eyebrow, body, Close. */
function panelShell({ store, kind, headingId, eyebrow, body }: ShellOptions): HTMLElement {
  const dossierExpanded = store.get("dossierExpanded");
  const close = () => store.get(kind === "aircraft" ? "closeAircraftPanel" : "closeAirportPanel")();
  const closeLabel = `Close ${kind} details`;
  return h(
    "aside",
    { className: `details-panel${dossierExpanded ? " details-panel--expanded" : ""}`, "aria-labelledby": headingId },
    h("button", { className: "details-panel-close-x", onClick: close, "aria-label": closeLabel }, "✕"),
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
      h("span", { className: "details-panel-eyebrow", id: headingId }, eyebrow),
      ...body,
      h("button", { className: "details-panel-close", onClick: close, "aria-label": closeLabel }, "Close"),
    ),
  );
}

interface RouteInfo {
  known: boolean;
  favorited: boolean;
  label: string;
}

function routeInfo(store: AppStore, dossier: AircraftDossier | null): RouteInfo {
  const origin = dossier?.originAirport;
  const destination = dossier?.destinationAirport;
  if (!origin || !destination) return { known: false, favorited: false, label: "" };
  return {
    known: true,
    favorited: isRouteFavorited(store.get("favoriteRoutes"), origin, destination),
    label: `${dossier?.originAirportIata ?? origin} → ${dossier?.destinationAirportIata ?? destination}`,
  };
}

// Says what the two buttons do (and why "route" may be unavailable), since
// a disabled button with only a hover title is a dead end on a phone.
function favoriteHint(route: RouteInfo): string {
  if (!route.known) return "Route unknown for this flight, so it can't be favorited yet";
  return route.favorited
    ? `Saved: ${route.label} shows in Favorites when a flight is live`
    : `Favorite the route to see any live ${route.label} flight in Favorites`;
}

const favoriteToggleClass = (active: boolean): string =>
  `details-panel-favorite-toggle${active ? " details-panel-favorite-toggle--active" : ""}`;

function favoriteToggles(store: AppStore, selectedPos: SelectedPosition, route: RouteInfo): HTMLElement {
  const aircraftFavorited = isAircraftFavorited(store.get("favoriteAircraft"), selectedPos.icao24);
  const aircraftToggle = h(
    "button",
    {
      type: "button",
      className: favoriteToggleClass(aircraftFavorited),
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
      className: favoriteToggleClass(route.favorited),
      onClick: () => store.get("toggleRouteFavorite")(),
      disabled: !route.known,
      "aria-pressed": String(route.favorited),
      "aria-label": "Favorite this route",
      title: route.known ? `Show any live ${route.label} flight in Favorites` : "Route not known for this aircraft yet",
    },
    `${route.favorited ? "★" : "☆"} Favorite route`,
  );
  return h("div", { className: "details-panel-favorite-toggles" }, aircraftToggle, routeToggle);
}

function renderAircraftPanel(store: AppStore): { panel: HTMLElement; updatedLine: HTMLElement } {
  const selectedPos = store.get("selectedPos")!;
  const dossier = store.get("dossier");
  const status = store.get("trackStatus");
  const route = routeInfo(store, dossier);
  const stale = isStale(selectedPos.observedAt, store.get("nowMs"));

  const focusButton = store.get("planeOffScreen")
    ? h("button", { type: "button", className: "details-panel-focus-toggle", onClick: () => store.get("requestFocusPlane")() }, "⌖ Focus Plane")
    : null;
  const updatedLine = h("p");
  writeUpdatedLine(updatedLine, updatedLineInput(store, selectedPos));

  const panel = panelShell({
    store,
    kind: "aircraft",
    headingId: "details-panel-heading",
    eyebrow: "Aircraft Details",
    body: [
      h("h2", null, selectedPos.callsign?.trim() || selectedPos.icao24.toUpperCase()),
      focusButton,
      favoriteToggles(store, selectedPos, route),
      h("p", { className: "details-panel-favorite-hint" }, favoriteHint(route)),
      h("p", { className: "details-panel-meta details-panel-meta--secondary" }, `ICAO24 ${selectedPos.icao24.toUpperCase()} · last leg traced above`),
      updatedLine,
      statusLine(status, store.get("gateApproximate") === true),
      aircraftFields(fieldContext(selectedPos, dossier, status, stale)),
    ],
  });
  return { panel, updatedLine };
}

function renderAirportPanel(store: AppStore): HTMLElement {
  const airportDossier = store.get("airportDossier")!;
  const airportInfo = store.get("airportInfo");

  const fields = h(
    "dl",
    { className: "details-panel-fields" },
    field("Municipality", airportInfo?.municipality || "—"),
    field("Country", airportInfo?.country || "—"),
    field("Latitude", `${airportDossier.lat.toFixed(4)}°`),
    field("Longitude", `${airportDossier.lon.toFixed(4)}°`),
  );

  return panelShell({
    store,
    kind: "airport",
    headingId: "airport-details-panel-heading",
    eyebrow: "Airport Details",
    body: [
      h("h2", null, airportDossier.name || airportDossier.code),
      h("p", { className: "details-panel-meta" }, `${airportInfo?.iataCode || airportDossier.code}${airportInfo?.icaoCode ? ` / ${airportInfo.icaoCode}` : ""}`),
      fields,
    ],
  });
}
