import type { Theme } from "../theme";
import "./ThemeToggle.css";

/**
 * Switches between the default dark UI (real OSM tiles) and the
 * Cyberpunk 2077-styled reskin (see VectorBasemap for the map itself,
 * and the token block in FlightMap.css for everything else). Controlled
 * by FlightMap, not self-managed — the theme now decides which map layer
 * mounts (TileLayer vs. VectorBasemap), not just CSS custom properties,
 * so FlightMap needs to be the single source of truth for it rather than
 * this button owning its own separate copy of the state.
 */
// Same path data as Dock's own (currently inert) "Layers" tile — a
// stacked-plates glyph reads as "switch layer/style" more directly than
// the star this replaced, which looked like a favorite toggle rather
// than a theme switch.
function LayersIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="theme-toggle-icon">
      <path d="M12 3 L21 8 L12 13 L3 8 Z" />
      <path d="M3 13 L12 18 L21 13" />
    </svg>
  );
}

export default function ThemeToggle({ theme, onToggle }: { theme: Theme; onToggle: () => void }) {
  return (
    <button
      type="button"
      className={`theme-toggle-btn${theme === "cyberpunk" ? " theme-toggle-btn--active" : ""}`}
      onClick={onToggle}
      aria-pressed={theme === "cyberpunk"}
    >
      <LayersIcon /> <span className="theme-toggle-label">Cyberpunk theme</span>
    </button>
  );
}
