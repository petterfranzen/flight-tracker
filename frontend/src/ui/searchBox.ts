import type { FlightPosition } from "../types/flight";
import { h, clear, type Attrs } from "./h";

const DEBOUNCE_MS = 250;

/** What differs between the search boxes of the flight-search panel. */
export interface SearchBoxConfig {
  /** Attributes of the text input (its `aria-controls` must name `listboxId`). */
  inputAttrs: Attrs;
  listboxId: string;
  /** Result rows get the ids `<optionIdPrefix>-<index>`. */
  optionIdPrefix: string;
  search: (query: string) => Promise<FlightPosition[]>;
  /** Puts the results list in the document; called when it opens while detached. */
  attach: (list: HTMLElement) => void;
  onChoose: (p: FlightPosition) => void;
  onEscape: () => void;
  /** Runs first in every render (rows this box's query drives outside its own list). */
  beforeRender?: () => void;
  /** True when something else already lists a match, so "No matching flights" would be wrong. */
  hasOtherMatches?: () => boolean;
}

const ARROW_STEP: ReadonlyMap<string, number> = new Map([
  ["ArrowDown", 1],
  ["ArrowUp", -1],
]);

function resultLabel(p: FlightPosition): string {
  return p.callsign?.trim() || p.icao24.toUpperCase();
}

function setActiveRow(listEl: HTMLElement, activeIdx: number): void {
  Array.from(listEl.children).forEach((child, i) => {
    const isActive = i === activeIdx;
    child.classList.toggle("flight-search-option--active", isActive);
    child.setAttribute("aria-selected", String(isActive));
  });
}

// The visible row in the dropdown. Screen readers hear the same text from
// SearchBox.status instead: a live region inserted together with its text
// (this row is rebuilt on every render) is not reliably announced (#421).
function statusRow(text: string): HTMLElement {
  return h("li", { className: "flight-search-status", "aria-hidden": "true" }, text);
}

/**
 * One combobox of the flight-search panel: a text input, its debounced
 * query, and the results listbox with keyboard navigation. The flight-number
 * box and the airport box are two of these with different configs.
 */
export class SearchBox {
  readonly input: HTMLInputElement;
  readonly list: HTMLElement;
  /** A stable, visually hidden live region for "Searching…" / "No matching flights"; the owner puts it in the document once. */
  readonly status: HTMLElement = h("p", { className: "visually-hidden", role: "status" });
  query = "";
  open = false;
  private results: FlightPosition[] = [];
  private loading = false;
  private activeIndex = -1;
  private requestSeq = 0;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly config: SearchBoxConfig) {
    this.list = h("ul", { className: "flight-search-results", role: "listbox", id: config.listboxId });
    this.input = h("input", config.inputAttrs);
    this.input.addEventListener("input", () => {
      this.query = this.input.value;
      this.open = true;
      this.runQuery();
      this.render();
    });
    this.input.addEventListener("focus", () => {
      this.open = true;
      this.render();
    });
    this.input.addEventListener("keydown", (e) => this.onKeydown(e));
  }

  /** Back to an empty, closed box (after a selection). Does not render. */
  reset(): void {
    this.query = "";
    this.results = [];
    this.open = false;
    this.activeIndex = -1;
  }

  /** Writes the query back to the input if something else changed it. */
  syncInput(): void {
    if (this.input.value !== this.query) this.input.value = this.query;
  }

  dispose(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
  }

  render(): void {
    const showDropdown = this.open && this.query.trim().length > 0;
    this.config.beforeRender?.();
    clear(this.list);
    if (showDropdown) this.fillList();
    else this.list.remove();
    const statusText = (showDropdown && this.statusText()) || "";
    if (this.status.textContent !== statusText) this.status.textContent = statusText;
    this.input.setAttribute("aria-expanded", String(showDropdown));
    if (this.activeIndex >= 0 && showDropdown) this.input.setAttribute("aria-activedescendant", this.optionId(this.activeIndex));
    else this.input.removeAttribute("aria-activedescendant");
  }

  private optionId(i: number): string {
    return `${this.config.optionIdPrefix}-${i}`;
  }

  private runQuery(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    const trimmed = this.query.trim();
    const seq = ++this.requestSeq;
    this.loading = trimmed.length > 0;
    if (!this.loading) this.results = [];
    this.render();
    if (this.loading) this.debounceTimer = setTimeout(() => this.fetchResults(trimmed, seq), DEBOUNCE_MS);
  }

  private fetchResults(trimmed: string, seq: number): void {
    this.config
      .search(trimmed)
      .then((list) => this.setResults(seq, list))
      .catch(() => this.setResults(seq, []))
      .finally(() => {
        if (seq === this.requestSeq) this.loading = false;
        this.render();
      });
  }

  /** Takes a response, unless a newer query has been sent since. */
  private setResults(seq: number, list: FlightPosition[]): void {
    if (seq !== this.requestSeq) return;
    this.results = list;
    this.activeIndex = list.length > 0 ? 0 : -1;
  }

  private onKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      this.config.onEscape();
      return;
    }
    if (!this.open || this.results.length === 0) return;
    if (e.key === "Enter") {
      e.preventDefault();
      this.config.onChoose(this.results[this.activeIndex] ?? this.results[0]);
      return;
    }
    const step = ARROW_STEP.get(e.key);
    if (step === undefined) return;
    e.preventDefault();
    this.activeIndex = (this.activeIndex + step + this.results.length) % this.results.length;
    this.render();
  }

  private fillList(): void {
    if (!this.list.parentElement) this.config.attach(this.list);
    const status = this.statusText();
    if (status) this.list.append(statusRow(status));
    this.results.forEach((p, i) => this.list.append(this.resultRow(p, i)));
  }

  private statusText(): string | null {
    if (this.results.length > 0) return null;
    if (this.loading) return "Searching…";
    // A match listed elsewhere is a result too: don't say "none" when one is listed.
    return this.config.hasOtherMatches?.() ? null : "No matching flights";
  }

  private resultRow(p: FlightPosition, i: number): HTMLElement {
    const active = i === this.activeIndex;
    return h(
      "li",
      {
        id: this.optionId(i),
        role: "option",
        "aria-selected": String(active),
        className: `flight-search-option${active ? " flight-search-option--active" : ""}`,
        // Updates only the active/aria-selected state on the existing rows
        // (no rebuild): a hover is exactly the moment Playwright's own
        // click() sequence is mid-flight (it hovers before it clicks), and
        // replacing the list's DOM nodes out from under a real, in-flight
        // pointer sequence loses the click entirely — confirmed live (a
        // synthetic in-page click always reached `choose`; a real
        // Playwright `.click()` on this same element never did, until this
        // handler stopped rebuilding the list on every hover).
        onMouseenter: () => {
          this.activeIndex = i;
          setActiveRow(this.list, i);
          this.input.setAttribute("aria-activedescendant", this.optionId(i));
        },
        onMousedown: (e: MouseEvent) => e.preventDefault(),
        onClick: () => this.config.onChoose(p),
      },
      h("span", { className: "flight-search-callsign" }, resultLabel(p)),
      h("span", { className: "flight-search-icao" }, p.icao24.toUpperCase()),
    );
  }
}
