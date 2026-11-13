import { expect, test, type Locator, type Page } from "@playwright/test";
import { mockFlightApi, settledBox, waitForMapReady } from "./helpers";

// One layout for every control-stack panel (section9-hq#264): each button
// opens the same shared, anchored container beside the stack — never a
// full-screen sheet, never moving the other buttons — and only one is open at
// a time. The four panels are search, favourites, watch and info.

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1440, height: 900 };

const PANELS = [
  { name: "search", button: ".flight-search-fab", panel: ".flight-search-panel" },
  { name: "favorites", button: ".favorites-panel-fab", panel: ".favorites-panel-body" },
  { name: "watch", button: ".watch-panel-toggle", panel: ".watch-panel-content" },
  { name: "info", button: ".map-legend-fab", panel: ".map-legend-body" },
] as const;

async function bootPhone(page: Page): Promise<void> {
  await page.setViewportSize(PHONE);
  await mockFlightApi(page);
  await page.goto("/");
  await waitForMapReady(page, 60_000);
}

async function openPanel(page: Page, button: string, panel: string): Promise<{ x: number; y: number; width: number; height: number }> {
  await page.locator(button).click();
  const el = page.locator(panel);
  await expect(el).toHaveClass(/control-panel--open/);
  return settledBox(el, 10_000);
}

async function activeClass(page: Page): Promise<string> {
  return page.evaluate(() => String((document.activeElement as HTMLElement | null)?.className ?? ""));
}

test.describe("phone control panels", () => {
  test("all four open the same anchored panel beside the stack, never full screen", async ({ page }) => {
    await bootPhone(page);
    const vp = page.viewportSize()!;

    // The stack's own boxes, before anything opens.
    const stack = new Map<string, { x: number; y: number; width: number; height: number }>();
    // The buttons are static chrome, not animated: a plain box read is enough
    // and does not fight this box's slow locator round-trips.
    for (const p of PANELS) stack.set(p.name, (await page.locator(p.button).boundingBox())!);

    const looks: string[] = [];
    for (const p of PANELS) {
      const fab = page.locator(p.button);
      const panel = page.locator(p.panel);
      const fabBox = stack.get(p.name)!;
      const box = await openPanel(page, p.button, p.panel);

      // Not full screen: a bounded card that stops inside the viewport.
      expect(box.width, `${p.name} panel width`).toBeLessThan(vp.width * 0.85);
      expect(box.height, `${p.name} panel height`).toBeLessThan(vp.height * 0.9);
      // Beside the stack, not over it: its left edge is past the button's right.
      expect(box.x, `${p.name} panel starts right of the button`).toBeGreaterThanOrEqual(fabBox.x + fabBox.width);
      // Inside the 16px gutter on the right.
      expect(box.x + box.width, `${p.name} panel right edge`).toBeLessThanOrEqual(vp.width - 15);
      // Tied to the viewport, top-aligned with the stack.
      expect(box.y).toBeGreaterThanOrEqual(15);
      expect(box.height).toBeLessThanOrEqual(vp.height - 30);

      // One shared container class, one look, and its own viewport-tied
      // scroll box.
      await expect(panel).toHaveClass(/control-panel/);
      const scroll = await panel.evaluate((el) => ({ overflowY: getComputedStyle(el).overflowY, maxHeight: getComputedStyle(el).maxHeight }));
      expect(scroll.overflowY, `${p.name} panel scrolls itself`).toBe("auto");
      expect(scroll.maxHeight, `${p.name} panel height is capped to the viewport`).not.toBe("none");
      const look = await panel.evaluate((el) => {
        const cs = getComputedStyle(el);
        return [cs.borderRadius, cs.borderTopColor, cs.borderTopWidth, cs.backgroundColor].join("|");
      });
      looks.push(look);
      expect(look).toContain("8px");

      // Phone panels keep #183's dialog semantics.
      await expect(panel).toHaveAttribute("role", "dialog");
      await expect(panel).toHaveAttribute("aria-modal", "true");
      await expect(fab).toHaveAttribute("aria-expanded", "true");

      // The whole stack stays visible and exactly where it was.
      for (const q of PANELS) {
        const qb = (await page.locator(q.button).boundingBox())!;
        const was = stack.get(q.name)!;
        expect(qb.x, `${q.name} button moved`).toBeCloseTo(was.x, 0);
        expect(qb.y, `${q.name} button moved`).toBeCloseTo(was.y, 0);
        expect(qb.width, `${q.name} button resized`).toBeCloseTo(was.width, 0);
      }

      // Same button toggles it shut.
      await fab.click();
      await expect(panel).not.toHaveClass(/control-panel--open/);
      await expect(fab).toHaveAttribute("aria-expanded", "false");
    }

    // All four share radius, border and background tokens.
    expect(new Set(looks).size, `panel looks: ${looks.join(" / ")}`).toBe(1);
  });

  test("only one panel is open at a time and another button switches", async ({ page }) => {
    await bootPhone(page);
    for (const p of PANELS) {
      await page.locator(p.button).click();
      const panel = page.locator(p.panel);
      await expect(panel).toHaveClass(/control-panel--open/);
      for (const other of PANELS) {
        if (other.name === p.name) continue;
        await expect(page.locator(other.panel), `${other.name} open with ${p.name}`).not.toHaveClass(/control-panel--open/);
      }
    }
    // The last one opened is still the only one open.
    await expect(page.locator(PANELS[3].panel)).toHaveClass(/control-panel--open/);
  });

  test("each panel closes on a map tap and on Escape, returning focus to its button", async ({ page }) => {
    await bootPhone(page);
    const vp = page.viewportSize()!;
    // Empty map, well clear of the panel and the bottom-left map controls.
    const mapPoint = { x: vp.width - 24, y: vp.height - 150 };

    for (const p of PANELS) {
      const panel = page.locator(p.panel);

      await openPanel(page, p.button, p.panel);
      await page.mouse.click(mapPoint.x, mapPoint.y);
      await expect(panel, `${p.name} closed by a map tap`).not.toHaveClass(/control-panel--open/);

      await openPanel(page, p.button, p.panel);
      await page.keyboard.press("Escape");
      await expect(panel, `${p.name} closed by Escape`).not.toHaveClass(/control-panel--open/);
      await expect.poll(() => activeClass(page), `${p.name} focus back on its button`).toContain(p.button.slice(1));
    }
  });

  test("the date field sits inside its panel", async ({ page }) => {
    await bootPhone(page);
    const panelBox = await openPanel(page, ".watch-panel-toggle", ".watch-panel-content");
    const date = await page.locator(".watch-panel-date").boundingBox();
    expect(date).not.toBeNull();
    expect(date!.x).toBeGreaterThanOrEqual(panelBox.x);
    expect(date!.x + date!.width).toBeLessThanOrEqual(panelBox.x + panelBox.width + 0.5);
    expect(date!.height).toBeGreaterThanOrEqual(44);
  });

});

test("desktop keeps all four panels as inline cards in the left column, none full screen", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await mockFlightApi(page);
  await page.goto("/");
  await waitForMapReady(page, 60_000);

  const vp = page.viewportSize()!;
  const column = (await page.locator(".left-overlay-stack").boundingBox())!;
  await expect(column.width).toBeLessThan(300); // the desktop side column, not a sheet

  // Phone-only controls are gone; the three cards are inline.
  for (const sel of [".flight-search-fab", ".favorites-panel-fab", ".map-legend-fab"]) {
    await expect(page.locator(sel)).toBeHidden();
  }
  await expect(page.locator(".flight-search-panel")).toBeVisible();
  await expect(page.locator(".favorites-panel-body")).toBeVisible();

  // Open the one collapsible card and check every visible panel stays in the column.
  await page.locator(".watch-panel-toggle").click();
  await expect(page.locator(".watch-panel-content")).toBeVisible();

  for (const sel of [".flight-search-panel", ".favorites-panel-body", ".watch-panel-content"]) {
    const b = (await page.locator(sel).boundingBox())!;
    expect(b.x, `${sel} inside the column`).toBeGreaterThanOrEqual(column.x - 1);
    expect(b.x + b.width, `${sel} inside the column`).toBeLessThanOrEqual(column.x + column.width + 1);
    expect(b.height, `${sel} not full screen`).toBeLessThan(vp.height - 40);
  }
});
