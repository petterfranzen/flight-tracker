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
export default function ThemeToggle({ theme, onToggle }: { theme: Theme; onToggle: () => void }) {
  return (
    <button
      type="button"
      className={`theme-toggle-btn${theme === "cyberpunk" ? " theme-toggle-btn--active" : ""}`}
      onClick={onToggle}
      aria-pressed={theme === "cyberpunk"}
    >
      {theme === "cyberpunk" ? "★" : "☆"} Cyberpunk theme
    </button>
  );
}
