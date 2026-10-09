import { h } from "./h";

/**
 * Shown instead of the app when the browser gives the map no WebGL2 context
 * (main.ts catches createMap's GPUInitializationError). Nothing else here
 * works without the map, so this replaces the page rather than sitting over
 * it. WebGL2 is almost always switched off rather than missing (virtual
 * machines, a blocklisted GPU, hardware acceleration off), so it says how to
 * turn it back on. `statusMessage` is the browser's own reason, when it gave one.
 */
export function mount(root: HTMLElement, statusMessage: string | null): void {
  root.replaceChildren(
    h(
      "div",
      { className: "webgl-notice-backdrop" },
      h(
        "div",
        { className: "resume-dialog webgl-notice", role: "alert", "aria-labelledby": "webgl-notice-heading" },
        h("h2", { id: "webgl-notice-heading" }, "This map needs WebGL2"),
        h("p", null, "Your browser didn't give the map WebGL2, which it draws with. It is usually switched off rather than missing:"),
        h(
          "ul",
          null,
          h("li", null, "Turn on hardware acceleration in the browser's settings, then restart the browser."),
          h("li", null, "In a virtual machine, turn on 3D acceleration for its display."),
          h(
            "li",
            null,
            "In Chrome, Edge or Vivaldi, ",
            h("code", null, "chrome://gpu"),
            " says why WebGL2 is off. If the GPU is on the blocklist, enable ",
            h("code", null, "chrome://flags/#ignore-gpu-blocklist"),
            ".",
          ),
        ),
        statusMessage ? h("p", { className: "webgl-notice-detail" }, `Browser: ${statusMessage}`) : null,
        h("button", { className: "resume-dialog-button", onClick: () => location.reload() }, "Reload"),
      ),
    ),
  );
}
