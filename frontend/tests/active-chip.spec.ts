import { expect, test } from "@playwright/test";
import { mockFlightApi } from "./helpers";

// The cyberpunk chip counts *active* aircraft (in the air, reported within 2 h),
// not everything the server still remembers. See FlightController.liveCount.

test("the chip says Active and shows the server's active count", async ({ page }) => {
  const requests: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/flights/live/count")) requests.push(r.url());
  });
  await mockFlightApi(page, { appDefaultTheme: true, activeCount: 12840 });
  await page.goto("/");
  const chip = page.locator(".tracked-chip");
  await expect(chip).toContainText("Active", { timeout: 10_000 });
  await expect(chip).toContainText("12,840");
  await expect(chip).not.toContainText("Tracked");
  expect(requests.length).toBeGreaterThan(0);
  expect(requests.every((u) => u.includes("active=true"))).toBe(true);
});
