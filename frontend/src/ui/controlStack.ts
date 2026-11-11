/**
 * One open panel at a time across the control stack (search, favourites,
 * watch, info — and the locate button to come). Each panel registers its own
 * open/close callbacks plus the panel element and its stack button; this
 * module decides which one is open, so the four buttons behave identically:
 * the same button toggles, another switches, and tapping the map closes.
 */

export type ControlPanelId = "search" | "favorites" | "watch" | "info";

export interface ControlPanelEntry {
  panel: HTMLElement;
  button: HTMLElement;
  open(): void;
  close(): void;
}

const entries = new Map<ControlPanelId, ControlPanelEntry>();
let active: ControlPanelId | null = null;
let listening = false;

/** The panel currently open, if any. */
export function activeControlPanel(): ControlPanelId | null {
  return active;
}

/**
 * Tapping anywhere outside the open panel and its own button closes it: the
 * map, the tracked chip, or another stack button (whose click then opens its
 * own panel). Pointerdown, before the tap's click, so a button switch never
 * leaves the first panel open for a frame.
 */
function onPointerDown(e: PointerEvent): void {
  if (!active) return;
  const entry = entries.get(active);
  if (!entry) return;
  const target = e.target as Node | null;
  if (target && (entry.panel.contains(target) || entry.button.contains(target))) return;
  closeControlPanel(active);
}

function setListening(next: boolean): void {
  if (next === listening) return;
  listening = next;
  if (next) document.addEventListener("pointerdown", onPointerDown, true);
  else document.removeEventListener("pointerdown", onPointerDown, true);
}

export function registerControlPanel(id: ControlPanelId, entry: ControlPanelEntry): () => void {
  entries.set(id, entry);
  setListening(true);
  return () => {
    if (entries.get(id) !== entry) return;
    entries.delete(id);
    if (active === id) active = null;
    if (entries.size === 0) setListening(false);
  };
}

export function toggleControlPanel(id: ControlPanelId): void {
  if (active === id) {
    closeControlPanel(id);
    return;
  }
  if (active) entries.get(active)?.close();
  active = id;
  entries.get(id)?.open();
}

export function closeControlPanel(id: ControlPanelId): void {
  const wasActive = active === id;
  if (wasActive) active = null;
  // Close it even when the stack has already moved on: a component that
  // closes itself after a selection must never linger open underneath.
  entries.get(id)?.close();
}
