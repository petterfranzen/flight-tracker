import { useEffect, useState } from "react";
import type { FavoriteAircraft, FavoriteRoute } from "../favorites";
import { routeKey } from "../favorites";
import type { FlightPosition } from "../types/flight";
import { fetchFlightLive, searchFlightsByAirport } from "../api/flightApi";
import "./FavoritesPanel.css";

// How often to re-check whether a favorited route/aircraft is currently
// live, while the panel is open — collapsed (the common case) does none of
// this work at all. Not urgent the way search's DEBOUNCE_MS is (nobody's
// mid-keystroke waiting on it), so this is generous compared to that.
const REFRESH_INTERVAL_MS = 20_000;

interface FavoritesPanelProps {
  routes: FavoriteRoute[];
  aircraft: FavoriteAircraft[];
  onRemoveRoute: (route: FavoriteRoute) => void;
  onRemoveAircraft: (entry: FavoriteAircraft) => void;
  onSelect: (p: FlightPosition) => void;
}

/**
 * Client-side-only favorites list (see favorites.ts for why) — a
 * collapsible panel, same interaction pattern as FlightSearch's advanced
 * panel, showing every favorited route/aircraft and whether each is
 * currently live. A route favorite has no single icao24 to poll directly
 * (it's an origin/destination pair, not one aircraft) — "is it live" is
 * answered by two searchFlightsByAirport calls (one per airport, already
 * ILIKE-matching the bare ICAO code exactly in practice) and taking
 * whichever aircraft appears in both result sets, i.e. touches both
 * airports. No new backend endpoint needed for that.
 */
export default function FavoritesPanel({ routes, aircraft, onRemoveRoute, onRemoveAircraft, onSelect }: FavoritesPanelProps) {
  const [open, setOpen] = useState(false);
  const [liveAircraft, setLiveAircraft] = useState<Record<string, FlightPosition>>({});
  const [liveRoutes, setLiveRoutes] = useState<Record<string, FlightPosition>>({});

  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    async function refresh() {
      const aircraftEntries = await Promise.all(
        aircraft.map(async (a) => {
          try {
            const live = await fetchFlightLive(a.icao24);
            return [a.icao24, live] as const;
          } catch {
            return [a.icao24, null] as const;
          }
        }),
      );

      const routeEntries = await Promise.all(
        routes.map(async (r) => {
          const key = routeKey(r.origin, r.destination);
          try {
            const [originMatches, destinationMatches] = await Promise.all([
              searchFlightsByAirport(r.origin),
              searchFlightsByAirport(r.destination),
            ]);
            const destinationIcaos = new Set(destinationMatches.map((p) => p.icao24));
            const match = originMatches.find((p) => destinationIcaos.has(p.icao24)) ?? null;
            return [key, match] as const;
          } catch {
            return [key, null] as const;
          }
        }),
      );

      if (cancelled) return;
      const liveEntry = (entry: readonly [string, FlightPosition | null]): entry is readonly [string, FlightPosition] => entry[1] != null;
      setLiveAircraft(Object.fromEntries(aircraftEntries.filter(liveEntry)));
      setLiveRoutes(Object.fromEntries(routeEntries.filter(liveEntry)));
    }

    refresh();
    const interval = setInterval(refresh, REFRESH_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [open, routes, aircraft]);

  const totalCount = routes.length + aircraft.length;

  return (
    <div className="favorites-panel">
      <button
        type="button"
        className="favorites-panel-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="favorites-panel-content"
      >
        {open ? "Hide favorites ▲" : `★ Favorites${totalCount > 0 ? ` (${totalCount})` : ""} ▼`}
      </button>

      {open && (
        <div id="favorites-panel-content" className="favorites-panel-content">
          {totalCount === 0 && (
            <p className="favorites-panel-empty">No favorites yet — star an aircraft or route from its details panel.</p>
          )}

          {aircraft.length > 0 && (
            <div className="favorites-panel-section">
              <h3>Aircraft</h3>
              <ul>
                {aircraft.map((a) => {
                  const live = liveAircraft[a.icao24];
                  const label = a.registration || a.callsign || a.icao24.toUpperCase();
                  return (
                    <li key={a.icao24} className={live ? "favorites-panel-item favorites-panel-item--live" : "favorites-panel-item"}>
                      <button
                        type="button"
                        className="favorites-panel-item-select"
                        disabled={!live}
                        onClick={() => live && onSelect(live)}
                      >
                        <span className="favorites-panel-item-dot" aria-hidden="true" />
                        {label}
                        <span className="favorites-panel-item-status">{live ? "live now" : "not tracked"}</span>
                      </button>
                      <button
                        type="button"
                        className="favorites-panel-item-remove"
                        onClick={() => onRemoveAircraft(a)}
                        aria-label={`Remove ${label} from favorites`}
                      >
                        ✕
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {routes.length > 0 && (
            <div className="favorites-panel-section">
              <h3>Routes</h3>
              <ul>
                {routes.map((r) => {
                  const key = routeKey(r.origin, r.destination);
                  const live = liveRoutes[key];
                  const label = `${r.originIata ?? r.origin} ↔ ${r.destinationIata ?? r.destination}`;
                  return (
                    <li key={key} className={live ? "favorites-panel-item favorites-panel-item--live" : "favorites-panel-item"}>
                      <button
                        type="button"
                        className="favorites-panel-item-select"
                        disabled={!live}
                        onClick={() => live && onSelect(live)}
                      >
                        <span className="favorites-panel-item-dot" aria-hidden="true" />
                        {label}
                        <span className="favorites-panel-item-status">{live ? "live now" : "not tracked"}</span>
                      </button>
                      <button
                        type="button"
                        className="favorites-panel-item-remove"
                        onClick={() => onRemoveRoute(r)}
                        aria-label={`Remove ${label} from favorites`}
                      >
                        ✕
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
