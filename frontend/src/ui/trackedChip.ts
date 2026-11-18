import type { AppStore } from "../state/appState";
import { h, clear } from "./h";

/**
 * The Active/Seen chip: inline (not a separate component in the original
 * either), rebuilt on every count change. aria-live lives on the stable wrapper
 * main.ts creates, not on .tracked-chip itself — a live region that is itself
 * replaced each tick is not reliably announced.
 *
 * Inert at construction: nothing renders or subscribes until `mount()`.
 */
export interface TrackedChipDeps {
  /** The stable polite live region the chip is rendered into. */
  root: HTMLElement;
  store: AppStore;
}

export interface TrackedChip {
  /** Render the chip and re-render it whenever the counts change. */
  mount: () => void;
}

export function createTrackedChip({ root, store }: TrackedChipDeps): TrackedChip {
  function renderTrackedChip(): void {
    clear(root);
    root.appendChild(
      h(
        "div",
        { className: "tracked-chip" },
        h("span", { className: "tracked-chip-dot", "aria-hidden": "true" }),
        h(
          "div",
          { className: "tracked-chip-rows" },
          h(
            "div",
            { className: "tracked-chip-row tracked-chip-row--active" },
            h("span", { className: "tracked-chip-label" }, "Active"),
            h("span", { className: "tracked-chip-value" }, store.get("trackedCount").toLocaleString()),
          ),
          h(
            "div",
            { className: "tracked-chip-row tracked-chip-row--seen" },
            h("span", { className: "tracked-chip-label" }, "Seen"),
            h("span", { className: "tracked-chip-value tracked-chip-value--seen" }, store.get("seenCount").toLocaleString()),
          ),
        ),
      ),
    );
  }

  function mount(): void {
    renderTrackedChip();
    store.subscribeMany(["trackedCount", "seenCount"], renderTrackedChip);
  }

  return { mount };
}
