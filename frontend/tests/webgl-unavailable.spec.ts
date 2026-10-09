import { expect, test } from "@playwright/test";
import { mockFlightApi } from "./helpers";

// A browser that gives the map no WebGL2 context (a VM without 3D
// acceleration, a blocklisted GPU, hardware acceleration off) gets a notice
// saying how to turn it on, not an uncaught error and a dead page.

test("without WebGL2 the app shows how to turn it on instead of crashing", async ({ page }) => {
  await page.addInitScript(() => {
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...rest: unknown[]) {
      if (type === "webgl2") {
        // What Chromium does when it refuses: the reason on a creation-error event, then null.
        this.dispatchEvent(new WebGLContextEvent("webglcontextcreationerror", { statusMessage: "GPU access is disabled" }));
        return null;
      }
      return (getContext as (...args: unknown[]) => unknown).call(this, type, ...rest);
    } as typeof getContext;
  });
  const pageErrors: Error[] = [];
  page.on("pageerror", (e) => pageErrors.push(e));
  await mockFlightApi(page);
  await page.goto("/");

  const notice = page.getByRole("alert");
  await expect(notice.getByRole("heading", { name: "This map needs WebGL2" })).toBeVisible();
  await expect(notice).toContainText("hardware acceleration");
  await expect(notice).toContainText("Browser: GPU access is disabled");
  await expect(notice.getByRole("button", { name: "Reload" })).toBeVisible();
  // It replaces the app: no half-built map or boot screen behind it.
  await expect(page.locator(".map-container, .boot-screen, .app-shell")).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});
