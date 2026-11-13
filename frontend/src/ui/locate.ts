import type { FlightMap } from "../map/map";
import { createUserLocationLayer } from "../map/userLocation";
import { h } from "./h";
import "../components/Locate.css";

/**
 * "Go to my location" (section9-hq#263), Google-Maps style: one button in
 * the control stack. A tap asks the browser for the position
 * (navigator.geolocation, high accuracy) and flies the map there through
 * the FlightMap adapter — which honours prefers-reduced-motion — then marks
 * it with a GL dot (map/userLocation.ts). A second tap follows the position
 * (watchPosition) until a third tap or any pan of the map stops it.
 *
 * The position stays in the browser: it is never sent to the backend,
 * logged or stored.
 */

/** App zoom units (see map/map.ts): near enough that the traffic around the user is on screen. */
const LOCATE_ZOOM = 11;
const GEO_TIMEOUT_MS = 10_000;
const TOAST_MS = 6_000;

type Phase = "idle" | "locating" | "centred" | "error";

function crosshairIcon(): SVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.setAttribute("class", "map-locate-icon");
  // Circle + centre dot + four ticks: the same line-icon weight as the dock's.
  svg.innerHTML =
    '<circle cx="12" cy="12" r="7.5" /><circle cx="12" cy="12" r="2.4" fill="currentColor" stroke="none" />' +
    '<line x1="12" y1="1.5" x2="12" y2="5" /><line x1="12" y1="19" x2="12" y2="22.5" />' +
    '<line x1="1.5" y1="12" x2="5" y2="12" /><line x1="19" y1="12" x2="22.5" y2="12" />';
  return svg;
}

export function mount(root: HTMLElement, map: FlightMap): () => void {
  const layer = createUserLocationLayer(map);

  let phase: Phase = "idle";
  let following = false;
  let denied = false;
  let watchId: number | null = null;
  let position: { lat: number; lon: number } | null = null;
  let toastTimer: ReturnType<typeof setTimeout> | null = null;

  const label = h("span", { className: "map-locate-label" }, "My location");
  const button = h(
    "button",
    {
      type: "button",
      className: "map-locate-button",
      "aria-label": "Go to my location",
      onClick: () => onClick(),
    },
    crosshairIcon(),
    " ",
    label,
  );
  // position:fixed (see Locate.css) — anchored to the viewport like
  // .app-header, not to the stack's own 220px column.
  const toast = h("div", { className: "locate-toast", role: "status", "aria-live": "polite" });
  toast.hidden = true;
  const container = h("div", { className: "map-locate" }, button, toast);
  root.appendChild(container);

  function showToast(text: string): void {
    if (toastTimer) clearTimeout(toastTimer);
    toast.textContent = text;
    toast.hidden = false;
    toastTimer = setTimeout(() => {
      toast.hidden = true;
    }, TOAST_MS);
  }

  function stopFollowing(): void {
    following = false;
    if (watchId != null) {
      navigator.geolocation?.clearWatch(watchId);
      watchId = null;
    }
  }

  function render(): void {
    button.classList.toggle("map-locate-button--active", phase === "centred");
    button.classList.toggle("map-locate-button--error", phase === "error");
    button.disabled = phase === "locating" || (phase === "error" && denied);
    button.setAttribute("aria-busy", String(phase === "locating"));
    button.setAttribute("aria-pressed", String(following));
    button.setAttribute(
      "aria-label",
      phase === "error"
        ? "My location unavailable"
        : following
          ? "Stop following my location"
          : phase === "centred"
            ? "Follow my location"
            : "Go to my location",
    );
  }

  function applyPosition(lat: number, lon: number, move: boolean): void {
    position = { lat, lon };
    layer.set(position);
    if (move) map.setView([lat, lon], LOCATE_ZOOM, { animate: true });
  }

  function geolocation(): Geolocation | undefined {
    return typeof navigator !== "undefined" ? navigator.geolocation : undefined;
  }

  function locate(): void {
    const geo = geolocation();
    if (!geo) {
      phase = "error";
      showToast("Location is not available in this browser.");
      render();
      return;
    }
    phase = "locating";
    render();
    geo.getCurrentPosition(
      (pos) => {
        applyPosition(pos.coords.latitude, pos.coords.longitude, true);
        phase = "centred";
        render();
      },
      (err) => {
        // A denial is final in the browser: settle into an error state and
        // never prompt again. A timeout or an unavailable fix is retryable.
        denied = err.code === err.PERMISSION_DENIED;
        phase = "error";
        showToast(
          denied
            ? "Location permission was denied. Turn it on in your browser settings to use this."
            : err.code === err.TIMEOUT
              ? "Getting your location took too long. Try again."
              : "Your location could not be determined.",
        );
        render();
      },
      { enableHighAccuracy: true, timeout: GEO_TIMEOUT_MS, maximumAge: 0 },
    );
  }

  function follow(): void {
    const geo = geolocation();
    if (!geo) return;
    stopFollowing();
    following = true;
    watchId = geo.watchPosition(
      (pos) => applyPosition(pos.coords.latitude, pos.coords.longitude, true),
      () => {
        // Follow dropping out is not fatal: stay centred on the last fix.
        stopFollowing();
        render();
      },
      { enableHighAccuracy: true, maximumAge: 5_000 },
    );
    render();
  }

  function onClick(): void {
    if (phase === "locating") return;
    if (following) {
      stopFollowing();
      render();
      return;
    }
    if (phase === "centred" && position) {
      // Already here: a second tap starts following, like Google Maps.
      map.setView([position.lat, position.lon], LOCATE_ZOOM, { animate: true });
      follow();
      return;
    }
    locate();
  }

  // Any pan of the map ends following — the user is looking somewhere else.
  map.onUserMoveStart(() => {
    if (following) {
      stopFollowing();
      render();
    }
  });

  render();

  return () => {
    stopFollowing();
    if (toastTimer) clearTimeout(toastTimer);
    layer.destroy();
    container.remove();
  };
}
