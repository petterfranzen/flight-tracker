/**
 * Tiny `document.createElement` helper — no virtual DOM, no diffing. Each UI
 * module rebuilds only the fragment it owns (typically small: a panel, a
 * list) directly against the real DOM, which is cheap enough at this scale
 * that a VDOM buys nothing.
 */
export type Attrs = Record<string, unknown> | null | undefined;
export type Child = Node | string | number | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Attrs,
  ...children: (Child | Child[])[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value == null || value === false) continue;
      if (key === "className") el.className = String(value);
      else if (key === "style" && typeof value === "object") Object.assign(el.style, value as object);
      else if (key.startsWith("on") && typeof value === "function") {
        el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
      } else if (value === true) {
        el.setAttribute(key, "");
      } else {
        el.setAttribute(key, String(value));
      }
    }
  }
  appendChildren(el, children);
  return el;
}

function appendChildren(el: HTMLElement, children: (Child | Child[])[]): void {
  for (const child of children) {
    if (Array.isArray(child)) {
      appendChildren(el, child);
      continue;
    }
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

/** Removes every child node — used by UI modules that rebuild their own subtree in place. */
export function clear(el: HTMLElement): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}
