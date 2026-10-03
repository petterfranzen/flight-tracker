import type L from "leaflet";

/**
 * Opt-in diagnostics for a device the app misbehaves on (add ?debug to the
 * URL): sizes, WebGL and tile state, and the last errors, in a small panel a
 * screenshot can carry back. Read-only; nothing here runs without the flag.
 */
export function mountDebugOverlay(map: L.Map): void {
  const errors: string[] = [];
  const note = (s: string): void => {
    errors.push(s.slice(0, 120));
    if (errors.length > 4) errors.shift();
  };
  window.addEventListener("error", (e) => note(`error: ${e.message}`));
  window.addEventListener("unhandledrejection", (e) => note(`rejection: ${String((e.reason as Error)?.message ?? e.reason)}`));

  let tileErrors = 0;
  document.addEventListener("error", (e) => {
    if ((e.target as HTMLElement | null)?.tagName === "IMG") tileErrors++;
  }, true);

  const el = document.createElement("pre");
  el.style.cssText = "position:fixed;left:4px;top:4px;z-index:99999;margin:0;padding:6px;max-width:92vw;font:10px/1.35 monospace;color:#0f0;background:rgba(0,0,0,.78);pointer-events:none;white-space:pre-wrap;word-break:break-all";
  document.body.append(el);

  const container = map.getContainer();
  function gl(): { loaded: boolean; tiles: boolean; lost: boolean; canvas: string } | null {
    let layer: { getMaplibreMap?: () => any; getCanvas?: () => HTMLCanvasElement } | null = null;
    map.eachLayer((l) => {
      if ((l as unknown as { getMaplibreMap?: unknown }).getMaplibreMap) layer = l as never;
    });
    const glMap = (layer as any)?.getMaplibreMap?.();
    if (!glMap) return null;
    const canvas = glMap.getCanvas() as HTMLCanvasElement;
    const ctx = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    return { loaded: !!glMap.loaded?.(), tiles: !!glMap.areTilesLoaded?.(), lost: !!ctx?.isContextLost?.(), canvas: `${canvas.width}x${canvas.height}` };
  }

  function render(): void {
    const r = container.getBoundingClientRect();
    const s = map.getSize();
    const c = map.getCenter();
    const vv = window.visualViewport;
    const tiles = container.querySelectorAll(".leaflet-tile").length;
    const loaded = container.querySelectorAll(".leaflet-tile-loaded").length;
    const g = gl();
    el.textContent = [
      navigator.userAgent.replace(/^Mozilla\/5.0 /, "").slice(0, 90),
      `dpr ${window.devicePixelRatio}  inner ${innerWidth}x${innerHeight}  visual ${vv ? `${Math.round(vv.width)}x${Math.round(vv.height)}` : "n/a"}`,
      `container ${Math.round(r.width)}x${Math.round(r.height)}  leaflet ${s.x}x${s.y}${Math.round(r.height) !== s.y ? "  <-- MISMATCH" : ""}`,
      `z${map.getZoom()} @${c.lat.toFixed(2)},${c.lng.toFixed(2)}  markers ${container.querySelectorAll(".plane-icon").length}  clusters ${container.querySelectorAll(".cluster-icon").length}`,
      `raster tiles ${loaded}/${tiles}  img errors ${tileErrors}`,
      g ? `webgl loaded ${g.loaded} tiles ${g.tiles} contextLost ${g.lost} canvas ${g.canvas}` : "webgl basemap: none",
      ...errors,
    ].join("\n");
  }
  render();
  setInterval(render, 1000);
}
