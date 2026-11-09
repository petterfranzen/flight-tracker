import type { AppStore } from "../state/appState";
import { h, clear } from "./h";
import "../components/WatchToast.css";

const AUTO_DISMISS_MS = 15_000;

/**
 * The small event banner over the map: #149's departure toast, widened into
 * the general watched-flight banner (#82 design §5). It shows the flight, the
 * event text and a Go-to button, needs no permission, and is dismissible.
 * `watchNotice` is the detector's event; `departureToast` remains the
 * flag-off path so #149's behaviour is unchanged in production.
 */
export function mount(root: HTMLElement, store: AppStore): () => void {
  const el = h("div", { className: "watch-toast", role: "status", "aria-live": "polite" });
  el.hidden = true;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let shown: { text: string; key: string } | null = null;

  function dismiss(): void {
    if (timer) clearTimeout(timer);
    timer = null;
    shown = null;
    if (store.get("watchNotice")) store.get("dismissWatchNotice")();
    else store.get("dismissDepartureToast")();
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
    const notice = store.get("watchNotice");
    const departure = store.get("departureToast");
    const flight = notice?.flight ?? departure;
    const text = notice?.text ?? (departure ? `${departure.flightNumber} is airborne` : "");
    const key = flight ? `${flight.flightNumber}|${flight.date}|${flight.airport}` : "";
    if (!flight) {
      if (timer) clearTimeout(timer);
      timer = null;
      shown = null;
      el.hidden = true;
      return;
    }
    // A second event while the first is up replaces it and restarts the timer.
    if (shown && shown.text === text && shown.key === key) {
      el.hidden = false;
      return;
    }
    if (timer) clearTimeout(timer);
    timer = null;
    shown = { text, key };
    clear(el);
    el.hidden = false;
    el.append(
      h("span", { className: "watch-toast-text" }, text),
      h(
        "button",
        {
          type: "button",
          className: "watch-toast-go",
          onClick: () => {
            store.get("goToWatched")(flight);
            dismiss();
          },
        },
        "Go to",
      ),
      h("button", { type: "button", className: "watch-toast-close", "aria-label": "Dismiss", onClick: dismiss }, "\u2715"),
    );
    timer = setTimeout(dismiss, AUTO_DISMISS_MS);
  }

  const unsubscribe = store.subscribeMany(["watchNotice", "departureToast"], render);
  render();
  root.appendChild(el);

  return () => {
    unsubscribe();
    if (timer) clearTimeout(timer);
    el.remove();
  };
}
