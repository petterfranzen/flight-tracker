/**
 * Two-theme switch (default dark UI vs. the Cyberpunk 2077-styled
 * reskin) — client-side only, localStorage, same pattern as favorites.ts.
 *
 * The attribute this sets (`document.documentElement.dataset.theme`) is
 * what every theme-aware CSS rule keys off (`[data-theme="cyberpunk"]`).
 * index.html has an inline, synchronous script that reads the same
 * localStorage key and sets this same attribute *before* any stylesheet
 * paints — critical for a stored "cyberpunk" preference: without it,
 * the page would flash the default theme for one frame on every load
 * before this module's own effect could catch up. That script is
 * necessarily a duplicate of loadTheme()'s logic (it runs before any JS
 * module is available to import from) — keep the two in sync if this
 * logic ever changes.
 */

export type Theme = "default" | "cyberpunk";

const THEME_KEY = "flighttracker:theme";

export function loadTheme(): Theme {
  try {
    return localStorage.getItem(THEME_KEY) === "cyberpunk" ? "cyberpunk" : "default";
  } catch {
    return "default";
  }
}

export function applyTheme(theme: Theme): void {
  if (theme === "cyberpunk") {
    document.documentElement.dataset.theme = "cyberpunk";
  } else {
    delete document.documentElement.dataset.theme;
  }
}

export function saveTheme(theme: Theme): void {
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // best-effort — see favorites.ts's module comment for the same reasoning
  }
  applyTheme(theme);
}
