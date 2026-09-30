import type { AppStore } from "../state/appState";
import { h } from "./h";

/**
 * Shown once a silent renewal of the backend's hot-poll window is actually
 * rejected (this browser's daily allowance used up) — see main.ts's own
 * dialog-timer logic for when that happens. Its button re-runs the same
 * "resume tracking" cycle an automatic renewal always has.
 */
export function mount(root: HTMLElement, store: AppStore): () => void {
  let backdrop: HTMLElement | null = null;

  function render(): void {
    const show = store.get("showResumeDialog");
    if (show && !backdrop) {
      backdrop = h(
        "div",
        { className: "resume-dialog-backdrop", role: "presentation" },
        h(
          "div",
          { className: "resume-dialog", role: "dialog", "aria-modal": "true", "aria-labelledby": "resume-dialog-heading" },
          h("h2", { id: "resume-dialog-heading" }, "Fast updates paused"),
          h(
            "p",
            null,
            "This browser has used up its allowance of fast (18-second) live updates for today. The map keeps refreshing every few minutes in the meantime — fast updates come back once the allowance resets.",
          ),
          h("button", { className: "resume-dialog-button", onClick: () => store.get("resumeTracking")() }, "Try again"),
        ),
      );
      root.appendChild(backdrop);
    } else if (!show && backdrop) {
      backdrop.remove();
      backdrop = null;
    }
  }
  render();
  const unsubscribe = store.subscribe("showResumeDialog", render);

  return () => {
    unsubscribe();
    backdrop?.remove();
  };
}
