import type { AppStore } from "../state/appState";
import { h } from "./h";
import "../components/BootScreen.css";

const STATUS_LINES = [
  "Initializing Gridlink terminal…",
  "Breaching ADS-B uplink…",
  "Authenticating Netwatch credentials…",
  "Syncing live aircraft feed…",
];

// Kept visible at least this long even if the real fetch resolves almost
// instantly — a boot sequence that flashes for 40ms reads as a glitch, not
// as "fast."
const MIN_VISIBLE_MS = 2600;
const STATUS_LINE_INTERVAL_MS = 700;

function buildNoise(): string {
  let hex = "";
  for (let i = 0; i < 900; i++) {
    hex += Math.floor(Math.random() * 16).toString(16) + (i % 44 === 43 ? "\n" : " ");
  }
  return hex;
}

/**
 * One boot-sequence run: flavor loading screen, real
 * loading state gating when it's allowed to dismiss, not a fixed timer:
 * the first aircraft data (`firstLoadDone`) and the basemap having drawn
 * its first view (`basemapReady`, see map/maplibreBasemap.ts
 * whenBasemapReady). Returns a teardown that clears every timer immediately —
 * used when the sequence finishes hiding itself.
 */
function runBootSequence(root: HTMLElement, store: AppStore): () => void {
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const mountedAt = Date.now();
  let lineIndex = 0;
  let pct = 0;
  let dismissing = false;

  const noiseEl = h("div", { className: "boot-noise", "aria-hidden": "true" }, buildNoise());
  const statusEl = h("div", { className: "boot-status" }, STATUS_LINES[0]);
  const barFill = h("div", { className: "boot-bar-fill", style: { width: "0%" } });
  const pctEl = h("div", { className: "boot-pct" }, "0%");
  const screen = h(
    "div",
    { className: "boot-screen", role: "status", "aria-live": "polite" },
    noiseEl,
    h("div", { className: "boot-scanlines", "aria-hidden": "true" }),
    h("div", { className: "boot-scan-sweep", "aria-hidden": "true" }),
    h(
      "div",
      { className: "boot-content" },
      h(
        "div",
        null,
        h("span", { className: "boot-logo-glitch", "data-text": "Netwatch Skygrid" }, "Netwatch Skygrid"),
        h("div", { className: "boot-logo-sub" }, "Gridlink OS // Netwatch Uplink Terminal"),
      ),
      statusEl,
      h("div", { className: "boot-bar-track" }, barFill),
      pctEl,
    ),
  );
  root.appendChild(screen);

  let lineTimer: ReturnType<typeof setTimeout> | null = null;
  let pctTimer: ReturnType<typeof setInterval> | null = null;
  let dismissTimer: ReturnType<typeof setTimeout> | null = null;
  let hideTimer: ReturnType<typeof setTimeout> | null = null;

  function scheduleLine(): void {
    if (lineIndex >= STATUS_LINES.length - 1) return;
    lineTimer = setTimeout(() => {
      lineIndex++;
      statusEl.textContent = STATUS_LINES[lineIndex];
      scheduleLine();
    }, STATUS_LINE_INTERVAL_MS);
  }
  scheduleLine();

  function startFill(): void {
    const tick = reduceMotion ? 260 : 170;
    pctTimer = setInterval(() => {
      pct = Math.min(92, pct + Math.random() * 8 + 3);
      barFill.style.width = `${pct}%`;
      pctEl.textContent = `${Math.floor(pct)}%`;
    }, tick);
  }
  startFill();

  function stopFill(): void {
    if (pctTimer) clearInterval(pctTimer);
    pctTimer = null;
  }

  function tryDismiss(): void {
    // Both the aircraft data and the basemap: dismissing on data alone let
    // the map be seen still loading its tiles right after the screen lifted.
    if (dismissing || !store.get("firstLoadDone") || !store.get("basemapReady")) return;
    const elapsed = Date.now() - mountedAt;
    const delay = Math.max(0, MIN_VISIBLE_MS - elapsed);
    dismissTimer = setTimeout(() => {
      dismissing = true;
      stopFill();
      pct = 100;
      barFill.style.width = "100%";
      pctEl.textContent = "100%";
      statusEl.textContent = "Uplink established.";
      screen.classList.add("boot-screen--hidden");
      hideTimer = setTimeout(() => screen.remove(), 450);
    }, delay);
  }
  tryDismiss();
  const unsubscribe = store.subscribeMany(["firstLoadDone", "basemapReady"], tryDismiss);

  return () => {
    if (lineTimer) clearTimeout(lineTimer);
    if (pctTimer) clearInterval(pctTimer);
    if (dismissTimer) clearTimeout(dismissTimer);
    if (hideTimer) clearTimeout(hideTimer);
    unsubscribe();
    screen.remove();
  };
}

/** The loading screen, shown once per page load until the first data and the basemap are in. */
export function mount(root: HTMLElement, store: AppStore): () => void {
  return runBootSequence(root, store);
}
