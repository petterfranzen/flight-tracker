import "./Dock.css";

/**
 * Bottom icon toolbar matching the earlier approved mockup's own dock —
 * coexists with the always-visible search/favorites/legend cards rather
 * than replacing them, the same way the mockup's own CSS treats it (its
 * one responsive rule just reflows the cards into a row on narrow
 * screens; nothing hides one for the other).
 *
 * Search/Favorites trigger the real search/favorites UI that's already
 * built: a direct .click()/.focus() on the existing FAB/toggle, rather
 * than threading new open-state props through those already-tested
 * components, since this is a redundant quick-access entry point to UI
 * that already fully manages its own open/closed state.
 *
 * Details/Layers have no real target yet — Details only makes sense
 * once an aircraft is selected (there's nothing to toggle open
 * otherwise), and there's no layer-switching concept beyond
 * ThemeToggle. Left disabled rather than wired to a fake action; a
 * natural next step once there's a real drawer for either to open/close
 * (see FlightSearch/FavoritesPanel's own open-state for the pattern).
 */
export default function Dock() {
  const openSearch = () => {
    const fab = document.querySelector<HTMLButtonElement>(".flight-search-fab");
    if (fab && getComputedStyle(fab).display !== "none") fab.click();
    else document.querySelector<HTMLInputElement>(".flight-search-input")?.focus();
  };
  const openFavorites = () => {
    document.querySelector<HTMLButtonElement>(".favorites-panel-toggle")?.click();
  };

  return (
    <div className="dock-wrap">
      <div className="dock">
        <button type="button" className="dock-tile" title="Search" aria-label="Search" onClick={openSearch}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="10.5" cy="10.5" r="6.5" />
            <line x1="15.5" y1="15.5" x2="21" y2="21" />
          </svg>
        </button>
        <button type="button" className="dock-tile" title="Favorites" aria-label="Favorites" onClick={openFavorites}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 3 L14.6 9 L21 9.7 L16.2 14 L17.6 20.3 L12 17 L6.4 20.3 L7.8 14 L3 9.7 L9.4 9 Z" />
          </svg>
        </button>
        <button type="button" className="dock-tile" title="Details (not wired yet)" aria-label="Details" disabled>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="12" r="9" />
            <line x1="12" y1="11" x2="12" y2="16.5" />
            <circle cx="12" cy="7.5" r="0.6" fill="currentColor" />
          </svg>
        </button>
        <button type="button" className="dock-tile" title="Layers (not wired yet)" aria-label="Layers" disabled>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 3 L21 8 L12 13 L3 8 Z" />
            <path d="M3 13 L12 18 L21 13" />
          </svg>
        </button>
      </div>
    </div>
  );
}
