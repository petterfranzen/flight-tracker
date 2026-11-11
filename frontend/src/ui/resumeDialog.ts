import type { AppStore } from "../state/appState";
import { h } from "./h";
import { activateModal, type ModalHandle } from "./a11y";

/**
 * Shown once a silent renewal of the backend's hot-poll window is actually
 * rejected (this browser's daily allowance used up) — see main.ts's own
 * dialog-timer logic for when that happens. Its button re-runs the same
 * "resume tracking" cycle an automatic renewal always has.
 *
 * It is a real modal dialog: it takes focus while open, keeps Tab inside it,
 * returns focus to whatever had it when it closes, and Escape dismisses it
 * without resuming (dismissResumeDialog), the same as a "not now".
 */
export function mount(root: HTMLElement, store: AppStore): () => void {
  let backdrop: HTMLElement | null = null;
  let trap: ModalHandle | null = null;

  function render(): void {
    const show = store.get("showResumeDialog");
    if (show && !backdrop) {
      const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const dialog = h(
        "div",
        { className: "resume-dialog", role: "dialog", "aria-modal": "true", "aria-labelledby": "resume-dialog-heading" },
        h("h2", { id: "resume-dialog-heading" }, "Fast updates paused"),
        h(
          "p",
          null,
          "This browser has used up its allowance of fast (18-second) live updates for today. The map keeps refreshing every few minutes in the meantime — fast updates come back once the allowance resets.",
        ),
        h("button", { className: "resume-dialog-button", onClick: () => store.get("resumeTracking")() }, "Try again"),
      );
      backdrop = h("div", { className: "resume-dialog-backdrop", role: "presentation" }, dialog);
      root.appendChild(backdrop);
      trap = activateModal(dialog, {
        onEscape: () => store.get("dismissResumeDialog")(),
        returnTo: opener,
        initial: dialog.querySelector<HTMLElement>(".resume-dialog-button"),
      });
    } else if (!show && backdrop) {
      backdrop.remove();
      backdrop = null;
      trap?.release();
      trap = null;
    }
  }
  render();
  const unsubscribe = store.subscribe("showResumeDialog", render);

  return () => {
    unsubscribe();
    trap?.release();
    trap = null;
    backdrop?.remove();
  };
}
