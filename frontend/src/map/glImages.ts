import type { FlightMap } from "./map";

// Images for the map's own symbol layers (planes, their callsign chip,
// airports), drawn once on a 2D canvas from the theme's tokens and handed to
// MapLibre with addImage. Drawn at a multiple of the CSS size so they stay
// sharp however far icon-size scales them.

/** A theme token's value (FlightMap.css `:root[data-theme="cyberpunk"]`), or `fallback` if it can't be read. */
export function cssToken(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

/** `color` (any CSS colour) with its alpha replaced by `alpha`. */
export function withAlpha(color: string, alpha: number): string {
  const ctx = document.createElement("canvas").getContext("2d")!;
  ctx.fillStyle = color;
  const c = ctx.fillStyle; // normalised: "#rrggbb" when opaque, "rgba(r, g, b, a)" otherwise
  if (c.startsWith("#")) return `rgba(${parseInt(c.slice(1, 3), 16)}, ${parseInt(c.slice(3, 5), 16)}, ${parseInt(c.slice(5, 7), 16)}, ${alpha})`;
  return c.replace(/,\s*[\d.]+\)$/, `, ${alpha})`);
}

export interface DrawnImage {
  data: ImageData;
  pixelRatio: number;
}

/** A canvas of `width` x `height` CSS px at `ratio`, its context scaled so drawing is in CSS px. */
export function canvas(width: number, height: number, ratio: number): { ctx: CanvasRenderingContext2D; done(): DrawnImage } {
  const el = document.createElement("canvas");
  el.width = Math.ceil(width * ratio);
  el.height = Math.ceil(height * ratio);
  const ctx = el.getContext("2d", { willReadFrequently: true })!;
  ctx.scale(ratio, ratio);
  return { ctx, done: () => ({ data: ctx.getImageData(0, 0, el.width, el.height), pixelRatio: ratio }) };
}

export interface LabelStyle {
  font: string;
  color: string;
  background: string;
  padX: number;
  padY: number;
  radius: number;
  letterSpacing?: string;
}

/** Draws `text` on its background box (padding included) with the box's top-left at (x, y), px. */
export function drawLabel(ctx: CanvasRenderingContext2D, text: string, style: LabelStyle, x: number, y: number): void {
  ctx.font = style.font;
  if (style.letterSpacing) ctx.letterSpacing = style.letterSpacing;
  const { width, height, ascent } = measureLabel(text, style);
  ctx.fillStyle = style.background;
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, style.radius);
  ctx.fill();
  ctx.fillStyle = style.color;
  ctx.textBaseline = "alphabetic";
  ctx.fillText(text, x + style.padX, y + style.padY + ascent);
}

/** The size of drawLabel's box, px, and the text's ascent within it. */
export function measureLabel(text: string, style: LabelStyle): { width: number; height: number; ascent: number } {
  const ctx = document.createElement("canvas").getContext("2d")!;
  ctx.font = style.font;
  if (style.letterSpacing) ctx.letterSpacing = style.letterSpacing;
  const m = ctx.measureText(text);
  const ascent = m.fontBoundingBoxAscent;
  return { width: Math.ceil(m.width + 2 * style.padX), height: Math.ceil(ascent + m.fontBoundingBoxDescent + 2 * style.padY), ascent };
}

// The map takes one resolver for missing images; it hands each id to the
// server registered for its prefix.
const servers = new WeakMap<FlightMap, { prefix: string; resolve(id: string): void }[]>();

/**
 * Serves every image whose id starts with `prefix` on demand: a symbol
 * layer's icon-image names it (e.g. "plane-label:SAS123") and MapLibre asks
 * for it the first time a tile needs it (setMissingStyleImageResolver).
 * Text images drawn before `font` has loaded use a fallback face, so they
 * are redrawn once it has.
 */
export function serveImages(map: FlightMap, prefix: string, draw: (key: string) => DrawnImage, font?: string): void {
  const stale = new Set<string>();
  let list = servers.get(map);
  if (!list) {
    const registered: { prefix: string; resolve(id: string): void }[] = [];
    list = registered;
    servers.set(map, registered);
    map.gl.setMissingStyleImageResolver((id) => registered.find((s) => id.startsWith(s.prefix))?.resolve(id));
  }
  list.push({
    prefix,
    resolve(id) {
      if (map.gl.hasImage(id)) return;
      const { data, pixelRatio } = draw(id.slice(prefix.length));
      map.gl.addImage(id, data, { pixelRatio });
      if (font && !document.fonts.check(font)) {
        if (stale.size === 0) document.fonts.load(font).then(redraw, () => {});
        stale.add(id);
      }
    },
  });
  function redraw(): void {
    for (const id of stale) {
      if (!map.gl.hasImage(id)) continue;
      const { data, pixelRatio } = draw(id.slice(prefix.length));
      map.gl.removeImage(id);
      map.gl.addImage(id, data, { pixelRatio });
    }
    stale.clear();
  }
}
