/**
 * Keyboard behaviour shared by the phone UI's modal overlays and the resume
 * dialog: move focus into a panel when it opens, keep Tab inside it while it
 * is modal, close it on Escape, and hand focus back to the control that
 * opened it. A desktop side card is *not* modal, so callers must only use
 * `activateModal` for the full-screen phone overlays and the dialog — see each
 * call site's own phone check.
 *
 * The focusable query mirrors what a browser treats as reachable: anything
 * natively focusable that is not disabled, plus an explicit tabindex. Elements
 * hidden by CSS are filtered out by the layout check below, so a control the
 * media query has hidden (the FAB under an open overlay, say) can never be a
 * Tab stop while the panel is open.
 */
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface ModalHandle {
  release(): void;
}

/** How many modal panels are open right now — a non-modal panel's Escape handler bails out when one is. */
let openModals = 0;
export function modalOpen(): boolean {
  return openModals > 0;
}

export interface ModalOptions {
  /** Called on Escape. */
  onEscape?: () => void;
  /** Element to hand focus back to on release; defaults to whatever had it when the trap was created. */
  returnTo?: HTMLElement | null;
  /** Element to focus when the trap opens; defaults to the panel's first focusable. */
  initial?: HTMLElement | null;
}

/** Whether the phone layout is in force (the same literal as every component's own media query). */
export function isPhone(): boolean {
  return window.matchMedia("(max-width: 768px)").matches;
}

function focusable(container: HTMLElement): HTMLElement[] {
  const all = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
  // getClientRects (not offsetParent) because the overlays are position:fixed,
  // where offsetParent is always null even for a visible element.
  return all.filter((el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden");
}

function activeElement(): HTMLElement | null {
  return document.activeElement instanceof HTMLElement ? document.activeElement : null;
}

/** Swallows a key the trap handles itself. */
function consume(e: KeyboardEvent): void {
  e.preventDefault();
  e.stopPropagation();
}

/**
 * Where Tab (or Shift+Tab) must wrap to so focus stays in `container`, or null
 * to let the browser move it: wrapping happens at either end, and from outside.
 */
function wrapTarget(container: HTMLElement, items: HTMLElement[], backwards: boolean): HTMLElement | null {
  const active = activeElement();
  const inside = active != null && container.contains(active);
  const edge = backwards ? items[0] : items[items.length - 1];
  if (inside && active !== edge) return null;
  return backwards ? items[items.length - 1] : items[0];
}

function trapTab(container: HTMLElement, e: KeyboardEvent): void {
  const items = focusable(container);
  if (items.length === 0) {
    e.preventDefault();
    return;
  }
  const target = wrapTarget(container, items, e.shiftKey);
  if (!target) return;
  e.preventDefault();
  target.focus();
}

/**
 * Traps Tab within `container`, calls `onEscape` on Escape, moves focus in on
 * creation and back to `returnTo` on `release`. Only meaningful while the
 * container is the topmost modal overlay.
 */
export function activateModal(container: HTMLElement, opts: ModalOptions = {}): ModalHandle {
  const previous = activeElement();
  let released = false;

  function onKeydown(e: KeyboardEvent): void {
    const onEscape = opts.onEscape;
    if (e.key === "Escape" && onEscape) {
      consume(e);
      onEscape();
    } else if (e.key === "Tab") {
      trapTab(container, e);
    }
  }

  document.addEventListener("keydown", onKeydown, true);
  openModals++;

  const items = focusable(container);
  const target = opts.initial ?? items[0] ?? null;
  if (target && !container.contains(document.activeElement)) target.focus();

  return {
    release(): void {
      if (released) return;
      released = true;
      openModals--;
      document.removeEventListener("keydown", onKeydown, true);
      // Synchronous: callers toggle the panel's own visibility class *before*
      // releasing, so a returnTo the media query had hidden is visible again
      // by the time focus() runs.
      returnFocus(container, opts.returnTo ?? previous);
    },
  };
}

function returnFocus(container: HTMLElement, back: HTMLElement | null): void {
  if (!back?.isConnected) return;
  if (!container.contains(back)) back.focus();
}

/**
 * Escape closes a non-modal panel (a desktop side card). Returns a function
 * that detaches the listener.
 */
export function closeOnEscape(onEscape: () => void): () => void {
  function onKeydown(e: KeyboardEvent): void {
    if (e.key !== "Escape") return;
    consume(e);
    onEscape();
  }
  document.addEventListener("keydown", onKeydown, true);
  return () => document.removeEventListener("keydown", onKeydown, true);
}
