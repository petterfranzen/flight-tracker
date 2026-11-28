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

  // A polite live region that exists from mount and only ever changes its
  // text (#421): one inserted together with its message is not reliably
  // announced. The panel itself is rebuilt in `host`, next to it.
  const announcer = h("p", { className: "visually-hidden", role: "status" });
  const host = h("div");
  root.append(announcer, host);

  // What the panel shows ("aircraft:<icao24>" / "airport:<code>"), so a new
  // selection can be told apart from a live update of the same one.
  let shownKey: string | null = null;
  // The control that had focus when the panel opened; focus goes back to it on close.
  let opener: HTMLElement | null = null;

  function renderAll(): void {
    const focus = focusInside(host);
    clear(host);
    updatedLineEl = null;
    const selectedPos = store.get("selectedPos");
    const airportDossier = store.get("airportDossier");
    if (selectedPos) {
      const built = renderAircraftPanel(store);
      updatedLineEl = built.updatedLine;
      host.appendChild(built.panel);
    } else if (airportDossier) {
      host.appendChild(renderAirportPanel(store));
    }
    const key = selectionKey(store);
    if (key === shownKey) {
      if (focus) restoreFocus(host, focus);
      return;
    }
    const opened = shownKey === null;
    shownKey = key;
    if (key) onSelected(opened, focus != null);
    else onClosed(focus != null);
  }

  /** A new selection (every one starts with the user: a click, a search, a favourite, a watch). */
  function onSelected(opened: boolean, focusWasInPanel: boolean): void {
    if (opened && !focusWasInPanel) {
      const active = activeElement();
      opener = active === document.body ? null : active;
    }
    announcer.textContent = `Selected ${host.querySelector(".details-panel-title")?.textContent ?? ""}`;
    host.querySelector<HTMLElement>(".details-panel-title")?.focus({ preventScroll: true });
  }

  /** The panel closed: hand focus back unless the user has already moved it elsewhere. */
  function onClosed(focusWasInPanel: boolean): void {
    announcer.textContent = "";
    const back = opener;
    opener = null;
    const current = activeElement();
    if (!focusWasInPanel && current && current !== document.body) return;
    const target = back && isShown(back) ? back : document.querySelector<HTMLElement>(".maplibregl-canvas");
    target?.focus({ preventScroll: true });
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

function selectionKey(store: AppStore): string | null {
  const selectedPos = store.get("selectedPos");
  if (selectedPos) return `aircraft:${selectedPos.icao24}`;
  const airportDossier = store.get("airportDossier");
  return airportDossier ? `airport:${airportDossier.code}` : null;
}

function activeElement(): HTMLElement | null {
  return document.activeElement instanceof HTMLElement ? document.activeElement : null;
}

function isShown(el: HTMLElement): boolean {
  return el.isConnected && el.getClientRects().length > 0;
}

/** Which control had focus in the panel: its first class and its index among those (the two favourite toggles share one). */
interface PanelFocus {
  className: string;
  index: number;
}

function focusInside(container: HTMLElement): PanelFocus | null {
  const active = activeElement();
  if (!active || !container.contains(active)) return null;
  const className = active.classList[0];
  if (!className) return { className: "details-panel-title", index: 0 };
  return { className, index: Array.from(container.getElementsByClassName(className)).indexOf(active) };
}

/**
 * Every change rebuilds the panel, which destroys the focused control (#421);
 * focus the same control in the new panel, or the heading if it is gone.
 */
function restoreFocus(container: HTMLElement, focus: PanelFocus): void {
  const matches = container.getElementsByClassName(focus.className);
  const target = (matches[focus.index] ?? matches[0] ?? container.querySelector(".details-panel-title")) as HTMLElement | null;
  target?.focus({ preventScroll: true });
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

/** The dossier's title: where focus lands on a new selection (tabindex -1: focusable, not a Tab stop). */
function heading(text: string): HTMLElement {
  return h("h2", { className: "details-panel-title", tabindex: "-1" }, text);
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
      heading(selectedPos.callsign?.trim() || selectedPos.icao24.toUpperCase()),
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
      heading(airportDossier.name || airportDossier.code),
      h("p", { className: "details-panel-meta" }, `${airportInfo?.iataCode || airportDossier.code}${airportInfo?.icaoCode ? ` / ${airportInfo.icaoCode}` : ""}`),
      fields,
    ],
  });
}
