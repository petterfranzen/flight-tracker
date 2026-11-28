import type { AppStore } from "../state/appState";
import type { FavoriteAircraft, FavoriteRoute } from "../favorites";
import { routeKey } from "../favorites";
import type { FlightPosition } from "../types/flight";
import { fetchFlightLive, searchFlightsByAirport } from "../api/flightApi";
import { h, clear } from "./h";
import { activateModal, isPhone, type ModalHandle } from "./a11y";
import { closeControlPanel, registerControlPanel, toggleControlPanel } from "./controlStack";
import "../components/FavoritesPanel.css";
import "../components/ControlPanel.css";

const REFRESH_INTERVAL_MS = 20_000;

function starIconSvg(): SVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.innerHTML = '<path d="M12 3 L14.6 9 L21 9.7 L16.2 14 L17.6 20.3 L12 17 L6.4 20.3 L7.8 14 L3 9.7 L9.4 9 Z" />';
  return svg;
}

/** One row in the panel: an aircraft or a route favorite, and its live match. */
interface FavoriteItem {
  label: string;
  live: FlightPosition | undefined;
  idleStatus: string;
  onRemove: () => void;
}

/**
 * Writes the line above the lists into the panel's one status element. It
 * exists from mount and only its text changes (#421): a live region inserted
 * together with its text, as the 20 s refresh used to do, is often missed.
 */
function writeSummary(el: HTMLElement, items: FavoriteItem[]): void {
  const empty = items.length === 0;
  // Says what is actionable: only live favorites can be selected.
  const text = empty
    ? "No favorites yet — use “Favorite aircraft” or “Favorite route” in a flight’s details panel."
    : items.some((item) => item.live)
      ? "Tap a live favorite to jump to it."
      : "None live right now — they light up when a matching flight is in the air.";
  el.className = empty ? "favorites-panel-empty" : "favorites-panel-hint";
  if (el.textContent !== text) el.textContent = text;
}

/**
 * Client-side-only favorites list. While open, polls whether each
 * favorited route/aircraft is currently live every REFRESH_INTERVAL_MS;
 * collapsed does none of that work at all.
 */
export function mount(root: HTMLElement, store: AppStore): () => void {
  let open = false;
  let liveAircraft: Record<string, FlightPosition> = {};
  let liveRoutes: Record<string, FlightPosition> = {};
  let refreshTimer: ReturnType<typeof setInterval> | null = null;
  let refreshGeneration = 0;
  // The phone drawer is modal (a11y.ts): Tab stays inside it, Escape closes it,
  // focus returns to the FAB. Null on desktop, where the card is not modal.
  let trap: ModalHandle | null = null;

  async function refresh(): Promise<void> {
    const generation = ++refreshGeneration;
    const aircraft = store.get("favoriteAircraft");
    const routes = store.get("favoriteRoutes");

    const aircraftEntries = await Promise.all(
      aircraft.map(async (a) => {
        try {
          return [a.icao24, await fetchFlightLive(a.icao24)] as const;
        } catch {
          return [a.icao24, null] as const;
        }
      }),
    );
    const routeEntries = await Promise.all(
      routes.map(async (r) => {
        const key = routeKey(r.origin, r.destination);
        try {
          const [originMatches, destinationMatches] = await Promise.all([searchFlightsByAirport(r.origin), searchFlightsByAirport(r.destination)]);
          const destinationIcaos = new Set(destinationMatches.map((p) => p.icao24));
          const match = originMatches.find((p) => destinationIcaos.has(p.icao24)) ?? null;
          return [key, match] as const;
        } catch {
          return [key, null] as const;
        }
      }),
    );

    if (generation !== refreshGeneration) return;
    const liveEntry = (entry: readonly [string, FlightPosition | null]): entry is readonly [string, FlightPosition] => entry[1] != null;
    liveAircraft = Object.fromEntries(aircraftEntries.filter(liveEntry));
    liveRoutes = Object.fromEntries(routeEntries.filter(liveEntry));
    renderContent();
  }

  function startPolling(): void {
    refresh();
    refreshTimer = setInterval(refresh, REFRESH_INTERVAL_MS);
  }
  function stopPolling(): void {
    refreshGeneration++; // invalidate any in-flight refresh
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = null;
  }

  // On mobile the open drawer covers the whole map, so selecting a favorite
  // would otherwise leave the user staring at the list with the plane hidden.
  // Closes first: closing the drawer hands focus back to its FAB, and the
  // selection then moves it on to the dossier's heading (#421).
  function selectAndClose(select: () => void): void {
    if (isPhone()) closeControlPanel("favorites");
    select();
  }

  function setOpen(next: boolean): void {
    if (open === next) return;
    open = next;
    if (open) startPolling();
    else stopPolling();
    renderAll();
  }

  /** See flightSearch.ts's syncModal — same modal-on-phone treatment. */
  function syncModal(): void {
    const modal = open && isPhone();
    if (modal && !trap) {
      body.setAttribute("role", "dialog");
      body.setAttribute("aria-modal", "true");
      body.setAttribute("aria-label", "Favorites");
      trap = activateModal(body, { onEscape: () => closeControlPanel("favorites"), returnTo: fab });
    } else if (!modal && trap) {
      trap.release();
      trap = null;
      body.removeAttribute("role");
      body.removeAttribute("aria-modal");
      body.removeAttribute("aria-label");
    }
  }

  const fab = h(
    "button",
    { type: "button", className: "favorites-panel-fab control-stack-button", "aria-controls": "favorites-panel-body", onClick: () => toggleControlPanel("favorites") },
    starIconSvg(),
  );
  const bodyClose = h("button", { type: "button", className: "favorites-panel-body-close control-panel-close", onClick: () => closeControlPanel("favorites") }, "Close favorites ✕");
  const toggle = h(
    "button",
    { type: "button", className: "favorites-panel-toggle", "aria-controls": "favorites-panel-content", onClick: () => toggleControlPanel("favorites") },
    "★ Favorites ▼",
  );
  const summary = h("p", { role: "status" });
  const sections = h("div");
  const content = h("div", { id: "favorites-panel-content", className: "favorites-panel-content" }, summary, sections);
  const body = h("div", { id: "favorites-panel-body", className: "favorites-panel-body control-panel" }, bodyClose, toggle);
  const container = h("div", { className: "favorites-panel" }, fab, body);

  function itemRow(item: FavoriteItem): HTMLElement {
    const { label, live } = item;
    return h(
      "li",
      { className: live ? "favorites-panel-item favorites-panel-item--live" : "favorites-panel-item" },
      h(
        "button",
        {
          type: "button",
          className: "favorites-panel-item-select",
          disabled: !live,
          title: live ? undefined : "Not live right now",
          onClick: () => live && selectAndClose(() => store.get("selectAircraft")(live)),
        },
        h("span", { className: "favorites-panel-item-dot", "aria-hidden": "true" }),
        label,
        h("span", { className: "favorites-panel-item-status" }, live ? "live now" : item.idleStatus),
      ),
      h("button", { type: "button", className: "favorites-panel-item-remove", "aria-label": `Remove ${label} from favorites`, onClick: item.onRemove }, "✕"),
    );
  }

  function aircraftItem(a: FavoriteAircraft): FavoriteItem {
    return {
      label: a.callsign || a.registration || a.icao24.toUpperCase(),
      live: liveAircraft[a.icao24],
      idleStatus: "not live",
      onRemove: () => store.get("removeFavoriteAircraft")(a),
    };
  }

  function routeItem(r: FavoriteRoute): FavoriteItem {
    return {
      label: `${r.originIata ?? r.origin} ↔ ${r.destinationIata ?? r.destination}`,
      live: liveRoutes[routeKey(r.origin, r.destination)],
      idleStatus: "no live flight",
      onRemove: () => store.get("removeFavoriteRoute")(r),
    };
  }

  function appendSection(title: string, items: FavoriteItem[]): void {
    if (items.length === 0) return;
    const list = h("ul", null, ...items.map(itemRow));
    sections.append(h("div", { className: "favorites-panel-section" }, h("h3", null, title), list));
  }

  function renderContent(): void {
    const aircraft = store.get("favoriteAircraft").map(aircraftItem);
    const routes = store.get("favoriteRoutes").map(routeItem);
    clear(sections);
    writeSummary(summary, [...aircraft, ...routes]);
    appendSection("Aircraft", aircraft);
    appendSection("Routes", routes);
  }

  function renderAll(): void {
    body.classList.toggle("control-panel--open", open);
    body.classList.toggle("favorites-panel-body--open", open);
    fab.setAttribute("aria-expanded", String(open));
    fab.setAttribute("aria-label", open ? "Close favorites" : "Favorites");
    toggle.setAttribute("aria-expanded", String(open));
    const totalCount = store.get("favoriteRoutes").length + store.get("favoriteAircraft").length;
    toggle.textContent = open ? "Hide favorites ▲" : `★ Favorites${totalCount > 0 ? ` (${totalCount})` : ""} ▼`;
    if (open) {
      if (!content.parentElement) body.appendChild(content);
      renderContent();
    } else if (content.parentElement) {
      content.remove();
    }
    syncModal();
  }
  renderAll();

  // Mirrors the original effect's `[open, routes, aircraft]` dependency —
  // a favorite added/removed while the panel is open restarts polling
  // immediately (fresh liveness for the new list) rather than waiting up
  // to REFRESH_INTERVAL_MS for the next scheduled tick.
  function onFavoritesChanged(): void {
    renderAll();
    if (open) {
      stopPolling();
      startPolling();
    }
  }
  const unsubscribeAircraft = store.subscribe("favoriteAircraft", onFavoritesChanged);
  const unsubscribeRoutes = store.subscribe("favoriteRoutes", onFavoritesChanged);

  root.appendChild(container);
  const unregister = registerControlPanel("favorites", {
    panel: body,
    button: fab,
    open: () => setOpen(true),
    close: () => setOpen(false),
  });
  return () => {
    unregister();
    unsubscribeAircraft();
    unsubscribeRoutes();
    stopPolling();
    trap?.release();
    trap = null;
    container.remove();
  };
}
