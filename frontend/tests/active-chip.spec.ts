import { expect, test } from "@playwright/test";
import { mockFlightApi } from "./helpers";

// The cyberpunk chip counts *active* aircraft (in the air, reported within 2 h),
// not everything the server still remembers. See FlightController.liveCount.

test("the chip says Active and shows the server's active count", async ({ page }) => {
  const requests: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/flights/live/count")) requests.push(r.url());
  });
  await mockFlightApi(page, { activeCount: 12840, seenCount: 31200 });
  await page.goto("/");
  const chip = page.locator(".tracked-chip");
  await expect(chip).toContainText("Active", { timeout: 10_000 });
  await expect(chip).toContainText("12,840");
  await expect(chip).not.toContainText("Tracked");
  expect(requests.length).toBeGreaterThan(0);
  expect(requests.some((u) => u.includes("active=true"))).toBe(true);
});

test("the chip also shows how many aircraft the server has seen in total", async ({ page }) => {
  await mockFlightApi(page, { activeCount: 12840, seenCount: 31200 });
  await page.goto("/");
  const seen = page.locator(".tracked-chip-row--seen");
  await expect(seen).toContainText("Seen", { timeout: 10_000 });
  await expect(seen).toContainText("31,200");
  await expect(page.locator(".tracked-chip-row--active")).toContainText("12,840");
});
