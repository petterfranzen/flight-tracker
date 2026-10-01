import { expect, test } from "@playwright/test";
import { mockFlightApi } from "./helpers";

// Cyberpunk is the default theme; only an explicit "default" choice (the
// theme toggle stores it) gets the plain one. Both index.html's pre-paint
// script and theme.ts's loadTheme() decide this, and must agree.

test("a first visit gets the cyberpunk theme", async ({ page }) => {
  await mockFlightApi(page, { appDefaultTheme: true });
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "cyberpunk");
  await expect(page.locator(".tracked-chip")).toBeVisible(); // cyberpunk-only UI, rendered by main.ts
});

test("an explicit plain-theme choice is kept", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("flighttracker:theme", "default"));
  await mockFlightApi(page);
  await page.goto("/");
  await page.waitForSelector(".leaflet-container");
  await expect(page.locator("html")).not.toHaveAttribute("data-theme", /.+/);
  await expect(page.locator(".tracked-chip")).toHaveCount(0);
});
