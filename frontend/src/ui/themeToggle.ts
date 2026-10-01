import type { AppStore } from "../state/appState";
import { h } from "./h";
import "../components/ThemeToggle.css";

// Same path data as Dock's own (currently inert) "Layers" tile — a
// stacked-plates glyph reads as "switch layer/style" more directly than a
// star, which looked like a favorite toggle rather than a theme switch.
function layersIcon(): SVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", "theme-toggle-icon");
  svg.innerHTML = '<path d="M12 3 L21 8 L12 13 L3 8 Z" /><path d="M3 13 L12 18 L21 13" />';
  return svg;
}

/**
 * Switches between the default dark UI and the Cyberpunk-styled reskin.
 * Controlled through the store, not self-managed — the theme decides which
 * map layer mounts (see map/map.ts), not just CSS custom properties, so
 * main.ts's own theme subscription is the single source of truth.
 */
export function mount(root: HTMLElement, store: AppStore): () => void {
  const label = h("span", { className: "theme-toggle-label" }, "Cyberpunk theme");
  const button = h(
    "button",
    { type: "button", className: "theme-toggle-btn", onClick: () => store.get("toggleTheme")() },
    layersIcon(),
    " ",
    label,
  );

  function render(): void {
    const active = store.get("theme") === "cyberpunk";
    button.classList.toggle("theme-toggle-btn--active", active);
    button.setAttribute("aria-pressed", String(active));
  }
  render();
  const unsubscribe = store.subscribe("theme", render);

  root.appendChild(button);
  return () => {
    unsubscribe();
    button.remove();
  };
}
