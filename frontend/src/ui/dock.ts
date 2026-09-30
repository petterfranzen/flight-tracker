import { h } from "./h";
import "../components/Dock.css";

/**
 * Bottom icon toolbar. Search/Favorites trigger the real search/favorites
 * UI that's already built via a direct .click()/.focus() on the existing
 * FAB/toggle, rather than threading new open-state props through those
 * already-independent modules. Details/Layers have no real target yet and
 * stay disabled.
 */
export function mount(root: HTMLElement): () => void {
  function openSearch(): void {
    const fab = document.querySelector<HTMLButtonElement>(".flight-search-fab");
    if (fab && getComputedStyle(fab).display !== "none") fab.click();
    else document.querySelector<HTMLInputElement>(".flight-search-input")?.focus();
  }
  function openFavorites(): void {
    document.querySelector<HTMLButtonElement>(".favorites-panel-toggle")?.click();
  }

  const dock = h(
    "div",
    { className: "dock-wrap" },
    h(
      "div",
      { className: "dock" },
      h(
        "button",
        { type: "button", className: "dock-tile", title: "Search", "aria-label": "Search", onClick: openSearch },
        svg('<circle cx="10.5" cy="10.5" r="6.5" /><line x1="15.5" y1="15.5" x2="21" y2="21" />'),
      ),
      h(
        "button",
        { type: "button", className: "dock-tile", title: "Favorites", "aria-label": "Favorites", onClick: openFavorites },
        svg('<path d="M12 3 L14.6 9 L21 9.7 L16.2 14 L17.6 20.3 L12 17 L6.4 20.3 L7.8 14 L3 9.7 L9.4 9 Z" />'),
      ),
      h(
        "button",
        { type: "button", className: "dock-tile", title: "Details (not wired yet)", "aria-label": "Details", disabled: true },
        svg('<circle cx="12" cy="12" r="9" /><line x1="12" y1="11" x2="12" y2="16.5" /><circle cx="12" cy="7.5" r="0.6" fill="currentColor" />'),
      ),
      h(
        "button",
        { type: "button", className: "dock-tile", title: "Layers (not wired yet)", "aria-label": "Layers", disabled: true },
        svg('<path d="M12 3 L21 8 L12 13 L3 8 Z" /><path d="M3 13 L12 18 L21 13" />'),
      ),
    ),
  );
  root.appendChild(dock);
  return () => dock.remove();
}

function svg(inner: string): SVGElement {
  const el = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  el.setAttribute("viewBox", "0 0 24 24");
  el.setAttribute("aria-hidden", "true");
  el.innerHTML = inner;
  return el;
}
