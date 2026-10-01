import type { AircraftDossier, AirportInfo, AirportSelection, LiveMarker, SelectedPosition } from "../types/flight";
import type { FavoriteAircraft, FavoriteRoute } from "../favorites";
import type { Theme } from "../theme";
import type { Store } from "./store";

/**
 * The whole app's shared, observable slots — one flat shape every UI module
 * reads from and writes to via the same Store instance. Action fields
 * (selectAircraft, toggleTheme, …) are set once in main.ts and never
 * reassigned; they exist here so a UI module needs nothing beyond the
 * store to both render and act, matching every module's
 * `mount(root, store)` contract.
 */
export interface AppState extends Record<string, unknown> {
  theme: Theme;
  zoom: number;
  trackedCount: number;
  firstLoadDone: boolean;
  /** The basemap has drawn its first view (always true on the plain theme). The boot screen waits on it. */
  basemapReady: boolean;
  showResumeDialog: boolean;

  selectedId: string | null;
  selectedPos: SelectedPosition | null;
  /**
   * selectedPos came from the server after the current selection was made.
   * A selection can start from a stale position (a favourites or search
   * list entry fetched seconds ago); the map only flies to it once this is
   * true — see handleSelectAircraft.
   */
  selectedPosFresh: boolean;
  dossier: AircraftDossier | null;
  dossierExpanded: boolean;
  planeOffScreen: boolean;
  focusRequest: number;
  nowMs: number;

  airportDossier: AirportSelection | null;
  airportInfo: AirportInfo | null;

  favoriteRoutes: FavoriteRoute[];
  favoriteAircraft: FavoriteAircraft[];

  selectAircraft: (p: LiveMarker) => void;
  selectAirport: (ap: AirportSelection) => void;
  closeAircraftPanel: () => void;
  closeAirportPanel: () => void;
  toggleDossierExpanded: () => void;
  requestFocusPlane: () => void;
  toggleAircraftFavorite: () => void;
  toggleRouteFavorite: () => void;
  removeFavoriteAircraft: (entry: FavoriteAircraft) => void;
  removeFavoriteRoute: (route: FavoriteRoute) => void;
  toggleTheme: () => void;
  resumeTracking: () => void;
}

export type AppStore = Store<AppState>;
