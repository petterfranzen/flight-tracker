import type { AppStore } from "../state/appState";
import { h } from "./h";
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
    h("li", { className: "map-legend-row" }, h("span", { className: "map-legend-swatch map-legend-swatch--selected" }), "Tracked / selected"),
    h("li", { className: "map-legend-row" }, h("span", { className: "map-legend-swatch map-legend-swatch--airport" }), "Airport"),
  );

  function setOpen(next: boolean): void {
    open = next;
    render();
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
  }
  render();

  body.append(closeButton, toggle);
  const container = h("div", { className: "map-legend" }, fab, body);
  root.appendChild(container);

  return () => container.remove();
}
