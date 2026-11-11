import { isStandalone } from "./installPrompt";

/**
 * iOS 26 installed-app bottom band (WebKit 301108): with viewport-fit=cover and
 * the black-translucent status bar, the standalone viewport ended short of the
 * bottom of the screen. The black-translucent meta is gone now (iOS 26.1+
 * deprecated it, section9-hq#277), so the top inset is 0 and the CSS workaround
 * is inert on current iOS; the class is kept as the guard for that bottom-band
 * regression. The CSS display-mode query is unreliable on iOS, so mark
 * <html class="standalone"> here (isStandalone also reads
 * navigator.standalone) and let FlightMap.css apply the workaround.
 *
 * `?vpdebug` in the URL, or five quick taps on the Active/Seen counter (the
 * installed app has no address bar), shows a readout of the viewport numbers,
 * so one screenshot from the phone tells us what iOS actually reports.
 */
export function applyStandaloneViewport(root: HTMLElement = document.documentElement): void {
  if (isStandalone()) root.classList.add("standalone");
  let mounted = false;
  const mount = (): void => {
    if (!mounted) mountViewportDebug(root);
    mounted = true;
  };
  if (new URLSearchParams(location.search).has("vpdebug")) mount();
  let taps: number[] = [];
  document.addEventListener("click", (e) => {
    if (!(e.target instanceof Element) || !e.target.closest(".tracked-chip-rows")) return;
    const now = performance.now();
    taps = [...taps.filter((t) => now - t < 3000), now];
    if (taps.length >= 5) mount();
  });
}

function mountViewportDebug(root: HTMLElement): void {
  const inset = document.createElement("div");
  inset.style.cssText =
    "position:fixed;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)";
  const probe = document.createElement("div");
  probe.style.cssText = "position:fixed;top:0;bottom:0;left:0;width:1px;visibility:hidden;pointer-events:none";
  const out = document.createElement("pre");
  out.setAttribute("aria-live", "off");
  out.style.cssText =
    "position:fixed;z-index:99999;left:50%;top:40%;transform:translateX(-50%);margin:0;padding:8px 10px;font:12px/1.4 var(--font-data, monospace);background:var(--color-panel);color:var(--color-text);border:1px solid var(--color-panel-border);border-radius:6px;pointer-events:none";
  document.body.append(inset, probe, out);
  const render = (): void => {
    const cs = getComputedStyle(inset);
    const shell = document.querySelector(".app-shell")?.getBoundingClientRect();
    out.textContent = [
      `standalone ${root.classList.contains("standalone")}  display-mode ${matchMedia("(display-mode: standalone)").matches}  nav.standalone ${(navigator as Navigator & { standalone?: boolean }).standalone}`,
      `screen ${screen.width}x${screen.height}  dpr ${devicePixelRatio}`,
      `inner ${innerWidth}x${innerHeight}  visualVP ${Math.round(visualViewport?.height ?? -1)}  docEl ${root.clientHeight}`,
      `fixed probe h ${Math.round(probe.getBoundingClientRect().height)}  shell ${shell ? `${Math.round(shell.top)}..${Math.round(shell.bottom)}` : "-"}`,
      `safe-area t${cs.paddingTop} r${cs.paddingRight} b${cs.paddingBottom} l${cs.paddingLeft}`,
      navigator.userAgent.match(/OS [\d_]+/)?.[0] ?? "",
    ].join("\n");
  };
  render();
  addEventListener("resize", render);
  setTimeout(render, 500);
  setTimeout(render, 2000);
}
