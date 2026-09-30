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
  showResumeDialog: boolean;

  selectedId: string | null;
  selectedPos: SelectedPosition | null;
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
