import type { AppStore } from "../state/appState";
import { h, clear } from "./h";
import "../components/WatchToast.css";

const AUTO_DISMISS_MS = 15_000;

/**
 * The small "SK528 is airborne" toast the background watch poll raises when a
 * watched flight leaves the ground, with a Go-to button. Mounted into a root
 * of its own (main.ts), so it sits over the map whatever panel is open.
 */
export function mount(root: HTMLElement, store: AppStore): () => void {
  const el = h("div", { className: "watch-toast", role: "status", "aria-live": "polite" });
  el.hidden = true;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function dismiss(): void {
    if (timer) clearTimeout(timer);
    timer = null;
    store.get("dismissDepartureToast")();
  }

  // The toast auto-dismisses, but never out from under a keyboard user: while
  // anything inside it has focus the countdown is suspended, and it restarts
  // (fresh, from the full interval) once focus leaves.
  function holdOpen(): void {
    if (timer) clearTimeout(timer);
    timer = null;
  }
  function restartCountdown(): void {
    if (!el.hidden) timer = setTimeout(dismiss, AUTO_DISMISS_MS);
  }
  el.addEventListener("focusin", holdOpen);
  el.addEventListener("focusout", restartCountdown);

  function render(): void {
    if (timer) clearTimeout(timer);
    timer = null;
    const w = store.get("departureToast");
    clear(el);
    if (!w) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    el.append(
      h("span", { className: "watch-toast-text" }, `${w.flightNumber} is airborne`),
      h(
        "button",
        {
          type: "button",
          className: "watch-toast-go",
          onClick: () => {
            store.get("goToWatched")(w);
            dismiss();
          },
        },
        "Go to",
      ),
      h("button", { type: "button", className: "watch-toast-close", "aria-label": "Dismiss", onClick: dismiss }, "\u2715"),
    );
    timer = setTimeout(dismiss, AUTO_DISMISS_MS);
  }

  const unsubscribe = store.subscribe("departureToast", render);
  render();
  root.appendChild(el);

  return () => {
    unsubscribe();
    if (timer) clearTimeout(timer);
    el.remove();
  };
}
