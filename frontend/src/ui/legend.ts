import type { AppStore } from "../state/appState";
import { h } from "./h";
import { activateModal, isPhone, type ModalHandle } from "./a11y";
import "../components/Legend.css";

function infoIcon(): SVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", "map-legend-toggle-icon");
  svg.innerHTML = '<circle cx="12" cy="12" r="9" /><line x1="12" y1="11" x2="12" y2="16.5" /><circle cx="12" cy="7.5" r="0.6" fill="currentColor" />';
  return svg;
}

/**
 * Static swatch key for the marks on the map that aren't self-evident.
 * Collapsible (mobile FAB pattern like FlightSearch/FavoritesPanel) —
 * purely informational, so defaulting closed costs nothing a first-time
 * user can't get back with one tap. Local, ephemeral `open` state — this
 * is the one piece of UI in the app with no reason to live in the shared
 * store (nothing else reads it).
 */
export function mount(root: HTMLElement): () => void {
  let open = false;
  // The phone sheet is modal (a11y.ts): Tab stays inside it, Escape closes it,
  // focus returns to the FAB. Desktop renders the list inline, not modal.
  let trap: ModalHandle | null = null;

  const body = h("div", { id: "map-legend-body", className: "map-legend-body" });
  const closeButton = h("button", { type: "button", className: "map-legend-body-close", onClick: () => setOpen(false) }, "Close legend ✕");
  const toggle = h(
    "button",
    { type: "button", className: "map-legend-toggle", "aria-controls": "map-legend-content", onClick: () => setOpen(!open) },
    infoIcon(),
    " ",
    h("span", null, "Legend ▼"),
  );
  const fab = h(
    "button",
    { type: "button", className: "map-legend-fab", "aria-controls": "map-legend-body", "aria-label": "Legend", onClick: () => setOpen(!open) },
    infoIcon(),
  );
  const list = h(
    "ul",
    { className: "map-legend-list", id: "map-legend-content" },
    h("li", { className: "map-legend-row" }, h("span", { className: "map-legend-swatch map-legend-swatch--aircraft" }), "Live aircraft"),
    h("li", { className: "map-legend-row" }, h("span", { className: "map-legend-swatch map-legend-swatch--watched" }), "Watched"),
    h("li", { className: "map-legend-row" }, h("span", { className: "map-legend-swatch map-legend-swatch--selected" }), "Tracked / selected"),
    h("li", { className: "map-legend-row" }, h("span", { className: "map-legend-swatch map-legend-swatch--airport" }), "Airport"),
  );

  function setOpen(next: boolean): void {
    open = next;
    render();
  }

  /** See flightSearch.ts's syncModal — same modal-on-phone treatment. */
  function syncModal(): void {
    const modal = open && isPhone();
    if (modal && !trap) {
      body.setAttribute("role", "dialog");
      body.setAttribute("aria-modal", "true");
      body.setAttribute("aria-label", "Map legend");
      trap = activateModal(body, { onEscape: () => setOpen(false), returnTo: fab });
    } else if (!modal && trap) {
      trap.release();
      trap = null;
      body.removeAttribute("role");
      body.removeAttribute("aria-modal");
      body.removeAttribute("aria-label");
    }
  }

  function render(): void {
    body.classList.toggle("map-legend-body--open", open);
    toggle.setAttribute("aria-expanded", String(open));
    fab.setAttribute("aria-expanded", String(open));
    fab.setAttribute("aria-label", open ? "Close legend" : "Legend");
    toggle.textContent = "";
    toggle.append(infoIcon(), " ", open ? "Hide legend ▲" : "Legend ▼");
    // Matches the original's `{open && <ul>...}` — absent from the DOM
    // when closed, not just visually hidden.
    if (open) body.appendChild(list);
    else if (list.parentElement) list.remove();
    syncModal();
  }
  render();

  body.append(closeButton, toggle);
  const container = h("div", { className: "map-legend" }, fab, body);
  root.appendChild(container);

  return () => {
    trap?.release();
    trap = null;
    container.remove();
  };
}
