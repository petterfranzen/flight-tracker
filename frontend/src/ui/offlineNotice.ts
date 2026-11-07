import type { AppStore } from "../state/appState";
import { h } from "./h";
import "../components/OfflineNotice.css";

/**
 * #181: the "no live feed" state. When the browser reports no network the app
 * keeps drawing its last view, but every plane is dimmed (see main.ts
 * renderAircraftLayer) so nothing reads as live traffic, and this banner says
 * why. Driven purely by the store's `offline` slot, which main.ts sets from
 * navigator.onLine and the online/offline events.
 *
 * Mounted into the app shell (not the map) so it is visible over the boot
 * screen on a cold offline open, and themed with the cyberpunk tokens only.
 */
export function mount(root: HTMLElement, store: AppStore): () => void {
  const el = h(
    "div",
    { className: "offline-notice", role: "status", "aria-live": "polite" },
    h("span", { className: "offline-notice-dot", "aria-hidden": "true" }),
    h("span", { className: "offline-notice-text" }, "Offline \u2014 live data unavailable"),
  );
  el.hidden = true;

  function render(): void {
    el.hidden = !store.get("offline");
  }

  const unsubscribe = store.subscribe("offline", render);
  render();
  root.appendChild(el);

  return () => {
    unsubscribe();
    el.remove();
  };
}
