import type { AppState } from "./appState";
import { loadFavoriteAircraft, loadFavoriteRoutes } from "../favorites";
import { loadWatched } from "../watchlist";

/** The initial shared AppState, before boot() replaces the placeholder actions. */
export function createInitialState(): AppState {
  return {
    zoom: 6,
    trackedCount: 0,
    seenCount: 0,
    firstLoadDone: false,
    basemapReady: false,
    showResumeDialog: false,

    selectedId: null,
    selectedPos: null,
    gateApproximate: false,
    selectedPosFresh: false,
    dossier: null,
    trackStatus: null,
    dossierExpanded: false,
    planeOffScreen: false,
    focusRequest: 0,
    nowMs: Date.now(),

    airportDossier: null,
    airportInfo: null,

    favoriteRoutes: loadFavoriteRoutes(),
    favoriteAircraft: loadFavoriteAircraft(),

    watchedFlights: loadWatched(),
    watchedStatus: {},
    departureToast: null,
    watchNotice: null,

    // Placeholders — replaced with real closures below once every module
    // they need (map, layers) exists. Never called before that happens:
    // nothing synchronous between here and the store.set() calls below
    // reaches user interaction.
    selectAircraft: () => {},
    selectAirport: () => {},
    closeAircraftPanel: () => {},
    closeAirportPanel: () => {},
    toggleDossierExpanded: () => {},
    requestFocusPlane: () => {},
    toggleAircraftFavorite: () => {},
    toggleRouteFavorite: () => {},
    removeFavoriteAircraft: () => {},
    removeFavoriteRoute: () => {},
    resumeTracking: () => {},
    dismissResumeDialog: () => {},

    watchFlight: () => {},
    unwatchFlight: () => {},
    goToWatched: () => {},
    dismissDepartureToast: () => {},
    dismissWatchNotice: () => {},
  };
}
