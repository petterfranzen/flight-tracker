import type { AppStore } from "../state/appState";
import type { FavoriteAircraft, FavoriteRoute } from "../favorites";

/**
 * The four favorites actions `boot()` wires into the store: favorite the
 * selected aircraft / route, and remove either from the list. Each writes the
 * store key, which is what persists the change (../favorites) and refreshes
 * whatever shows it (the panel subscribes to those keys).
 *
 * Inert at construction: the returned actions do nothing until the store
 * (and the lists) are wired up. The list reducers arrive through deps, so this
 * module needs no import of ../favorites beyond the two types.
 */
export interface FavoriteActionsDeps {
  store: AppStore;
  toggleFavoriteAircraft: (list: FavoriteAircraft[], entry: FavoriteAircraft) => FavoriteAircraft[];
  toggleFavoriteRoute: (list: FavoriteRoute[], entry: FavoriteRoute) => FavoriteRoute[];
}

export interface FavoriteActions {
  toggleAircraftFavorite: () => void;
  toggleRouteFavorite: () => void;
  removeFavoriteAircraft: (entry: FavoriteAircraft) => void;
  removeFavoriteRoute: (favRoute: FavoriteRoute) => void;
}

export function createFavoriteActions({ store, toggleFavoriteAircraft, toggleFavoriteRoute }: FavoriteActionsDeps): FavoriteActions {
  function toggleAircraftFavorite(): void {
    const selectedPos = store.get("selectedPos");
    if (!selectedPos) return;
    const dossier = store.get("dossier");
    store.set(
      "favoriteAircraft",
      toggleFavoriteAircraft(store.get("favoriteAircraft"), {
        icao24: selectedPos.icao24,
        registration: dossier?.registration ?? null,
        callsign: selectedPos.callsign,
      }),
    );
  }
  function toggleRouteFavorite(): void {
    const dossier = store.get("dossier");
    if (!dossier?.originAirport || !dossier?.destinationAirport) return;
    store.set(
      "favoriteRoutes",
      toggleFavoriteRoute(store.get("favoriteRoutes"), {
        origin: dossier.originAirport,
        originName: dossier.originAirportName,
        originIata: dossier.originAirportIata,
        destination: dossier.destinationAirport,
        destinationName: dossier.destinationAirportName,
        destinationIata: dossier.destinationAirportIata,
      }),
    );
  }
  function removeFavoriteAircraft(entry: FavoriteAircraft): void {
    store.set("favoriteAircraft", toggleFavoriteAircraft(store.get("favoriteAircraft"), entry));
  }
  function removeFavoriteRoute(favRoute: FavoriteRoute): void {
    store.set("favoriteRoutes", toggleFavoriteRoute(store.get("favoriteRoutes"), favRoute));
  }

  return { toggleAircraftFavorite, toggleRouteFavorite, removeFavoriteAircraft, removeFavoriteRoute };
}
