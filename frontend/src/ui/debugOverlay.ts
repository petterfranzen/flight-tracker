import type { FlightMap } from "../map/map";

/**
 * Opt-in diagnostics for a device the app misbehaves on (add ?debug to the
 * URL): sizes, WebGL and tile state, and the last errors, in a small panel a
 * screenshot can carry back. Read-only; nothing here runs without the flag.
 */
export function mountDebugOverlay(map: FlightMap): void {
  const errors: string[] = [];
  const note = (s: string): void => {
    errors.push(s.slice(0, 120));
    if (errors.length > 4) errors.shift();
  };
  window.addEventListener("error", (e) => note(`error: ${e.message}`));
  window.addEventListener("unhandledrejection", (e) => note(`rejection: ${String((e.reason as Error)?.message ?? e.reason)}`));

  const el = document.createElement("pre");
  el.style.cssText = "position:fixed;left:4px;top:4px;z-index:99999;margin:0;padding:6px;max-width:92vw;font:10px/1.35 monospace;color:#0f0;background:rgba(0,0,0,.78);pointer-events:none;white-space:pre-wrap;word-break:break-all";
  document.body.append(el);

  const container = map.getContainer();
  // MapLibre's own failures (a tile, the style, the worker) never reach window.onerror.
  let mapErrors = 0;
  map.gl.on("error", (e: { error?: { message?: string } }) => {
    mapErrors++;
    note(`map: ${String(e.error?.message ?? e.error)}`);
  });

  function gl(): { loaded: boolean; tiles: boolean; lost: boolean; canvas: string } {
    const canvas = map.gl.getCanvas();
    const ctx = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    return { loaded: map.gl.loaded(), tiles: map.gl.areTilesLoaded(), lost: !!ctx?.isContextLost?.(), canvas: `${canvas.width}x${canvas.height}` };
  }

  function render(): void {
    const r = container.getBoundingClientRect();
    const s = map.getSize();
    const c = map.getCenter();
    const vv = window.visualViewport;
    const g = gl();
    el.textContent = [
      navigator.userAgent.replace(/^Mozilla\/5.0 /, "").slice(0, 90),
      `dpr ${window.devicePixelRatio}  inner ${innerWidth}x${innerHeight}  visual ${vv ? `${Math.round(vv.width)}x${Math.round(vv.height)}` : "n/a"}`,
      `container ${Math.round(r.width)}x${Math.round(r.height)}  map ${s.x}x${s.y}${Math.round(r.height) !== s.y ? "  <-- MISMATCH" : ""}`,
      `z${map.getZoom().toFixed(2)} @${c.lat.toFixed(2)},${c.lon.toFixed(2)}  markers ${container.querySelectorAll(".plane-icon").length}  airports ${container.querySelectorAll(".default-airport-icon").length}`,
      `webgl loaded ${g.loaded} tiles ${g.tiles} contextLost ${g.lost} canvas ${g.canvas}  map errors ${mapErrors}`,
      ...errors,
    ].join("\n");
  }
  render();
  setInterval(render, 1000);
}
