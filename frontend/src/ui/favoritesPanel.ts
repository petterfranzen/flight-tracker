import type { AppStore } from "../state/appState";
import type { FavoriteAircraft, FavoriteRoute } from "../favorites";
import { routeKey } from "../favorites";
import type { FlightPosition } from "../types/flight";
import { fetchFlightLive, searchFlightsByAirport } from "../api/flightApi";
import { h, clear } from "./h";
import "../components/FavoritesPanel.css";

const REFRESH_INTERVAL_MS = 20_000;

function starIconSvg(): SVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.innerHTML = '<path d="M12 3 L14.6 9 L21 9.7 L16.2 14 L17.6 20.3 L12 17 L6.4 20.3 L7.8 14 L3 9.7 L9.4 9 Z" />';
  return svg;
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
  function selectAndClose(select: () => void): void {
    select();
    if (window.matchMedia("(max-width: 768px)").matches) setOpen(false);
  }

  function setOpen(next: boolean): void {
    if (open === next) return;
    open = next;
    if (open) startPolling();
    else stopPolling();
    renderAll();
  }

  const fab = h(
    "button",
    { type: "button", className: "favorites-panel-fab", "aria-controls": "favorites-panel-body", onClick: () => setOpen(!open) },
    starIconSvg(),
  );
  const bodyClose = h("button", { type: "button", className: "favorites-panel-body-close", onClick: () => setOpen(false) }, "Close favorites ✕");
  const toggle = h(
    "button",
    { type: "button", className: "favorites-panel-toggle", "aria-controls": "favorites-panel-content", onClick: () => setOpen(!open) },
    "★ Favorites ▼",
  );
  const content = h("div", { id: "favorites-panel-content", className: "favorites-panel-content" });
  const body = h("div", { id: "favorites-panel-body", className: "favorites-panel-body" }, bodyClose, toggle);
  const container = h("div", { className: "favorites-panel" }, fab, body);

  function itemRow(
    key: string,
    label: string,
    live: FlightPosition | undefined,
    idleStatus: string,
    onSelect: () => void,
    onRemove: () => void,
  ): HTMLElement {
    return h(
      "li",
      { className: live ? "favorites-panel-item favorites-panel-item--live" : "favorites-panel-item" },
      h(
        "button",
        { type: "button", className: "favorites-panel-item-select", disabled: !live, title: live ? undefined : "Not live right now", onClick: () => live && onSelect() },
        h("span", { className: "favorites-panel-item-dot", "aria-hidden": "true" }),
        label,
        h("span", { className: "favorites-panel-item-status" }, live ? "live now" : idleStatus),
      ),
      h("button", { type: "button", className: "favorites-panel-item-remove", "aria-label": `Remove ${label} from favorites`, onClick: onRemove }, "✕"),
    );
  }

  function renderContent(): void {
    const aircraft = store.get("favoriteAircraft");
    const routes = store.get("favoriteRoutes");
    const totalCount = routes.length + aircraft.length;
    clear(content);

    if (totalCount === 0) {
      content.append(h("p", { className: "favorites-panel-empty" }, "No favorites yet — use “Favorite aircraft” or “Favorite route” in a flight’s details panel."));
    }
    if (totalCount > 0) {
      // Says what is actionable: only live favorites can be selected.
      const liveCount = aircraft.filter((a) => liveAircraft[a.icao24]).length + routes.filter((r) => liveRoutes[routeKey(r.origin, r.destination)]).length;
      content.append(
        h(
          "p",
          { className: "favorites-panel-hint" },
          liveCount > 0 ? "Tap a live favorite to jump to it." : "None live right now — they light up when a matching flight is in the air.",
        ),
      );
    }
    if (aircraft.length > 0) {
      const list = h("ul");
      for (const a of aircraft) {
        const live = liveAircraft[a.icao24];
        const label = a.callsign || a.registration || a.icao24.toUpperCase();
        list.append(
          itemRow(
            a.icao24,
            label,
            live,
            "not live",
            () => live && selectAndClose(() => store.get("selectAircraft")(live)),
            () => store.get("removeFavoriteAircraft")(a),
          ),
        );
      }
      content.append(h("div", { className: "favorites-panel-section" }, h("h3", null, "Aircraft"), list));
    }
    if (routes.length > 0) {
      const list = h("ul");
      for (const r of routes) {
        const key = routeKey(r.origin, r.destination);
        const live = liveRoutes[key];
        const label = `${r.originIata ?? r.origin} ↔ ${r.destinationIata ?? r.destination}`;
        list.append(
          itemRow(
            key,
            label,
            live,
            "no live flight",
            () => live && selectAndClose(() => store.get("selectAircraft")(live)),
            () => store.get("removeFavoriteRoute")(r),
          ),
        );
      }
      content.append(h("div", { className: "favorites-panel-section" }, h("h3", null, "Routes"), list));
    }
  }

  function renderAll(): void {
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
  return () => {
    unsubscribeAircraft();
    unsubscribeRoutes();
    stopPolling();
    container.remove();
  };
}
