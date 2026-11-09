import { isStandalone } from "./installPrompt";

/**
 * Installed app on iOS 26: the layout viewport (100dvh, and `position: fixed;
 * inset: 0`) stops short of the home-indicator strip, so the map ends above
 * the bottom of the screen and the page background shows below it. The CSS
 * `display-mode: standalone` query isn't reliable on iOS either, which is why
 * the first fix (#196) didn't reach the phone.
 *
 * When running standalone, mark <html> and publish the physical screen height
 * for the current orientation as --standalone-h. FlightMap.css sizes the shell
 * to max(100dvh, that), so the map paints to the real bottom edge. MapLibre's
 * ResizeObserver picks up the new size. A no-op in the browser.
 */
export function applyStandaloneViewport(root: HTMLElement = document.documentElement): void {
  if (!isStandalone()) return;
  root.classList.add("standalone");
  const update = (): void => {
    const portrait = window.innerHeight >= window.innerWidth;
    const { width, height } = window.screen;
    const screenH = portrait ? Math.max(width, height) : Math.min(width, height);
    root.style.setProperty("--standalone-h", `${Math.max(screenH, window.innerHeight)}px`);
  };
  update();
  window.addEventListener("resize", update);
  window.addEventListener("orientationchange", update);
}
