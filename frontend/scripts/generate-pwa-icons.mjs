// Generates the PWA icons in public/icons/ from the app's own mark - the
// plane dart the map draws (PLANE_PATH in src/map/planes.ts,
// "M12 2 L19 20 L12 16 L5 20 Z") - on the cyberpunk background token
// (--color-bg / --color-marker in src/components/FlightMap.css). No new
// colours: both hex values below are copied from that file's cyberpunk
// block, so a re-run after a theme change keeps the icons in step.
//
// Rendering goes through Chromium so the shapes are the browser's own
// (same engine the app ships to). Playwright is a frontend devDependency,
// so this needs no extra install:
//
//   cd frontend && npm run icons
//
// In a cloud session set PW_CHROMIUM_PATH to the image's Chromium, the
// same variable playwright.config.ts honours.
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "icons");

// Copied from FlightMap.css: :root[data-theme="cyberpunk"].
const BG = "#050608"; // --color-bg
const MARK = "#3ce0ff"; // --color-marker

const PLANE_PATH = "M12 2 L19 20 L12 16 L5 20 Z";

// The dart's bounding box in its 24-unit space (x 5..19, y 2..20) - the
// centre it has to sit on, and the corner furthest from it, used to keep
// a maskable icon inside the safe circle.
const CX = 12;
const CY = 11;
const HALF_DIAGONAL = Math.hypot(7, 9); // corner (19,20) from (12,11)

/** One icon as an SVG string; `k` is the dart's scale in the 24-unit space. */
function svg(k) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <radialGradient id="glow" cx="50%" cy="42%" r="62%">
      <stop offset="0" stop-color="${MARK}" stop-opacity="0.16"/>
      <stop offset="1" stop-color="${MARK}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="512" height="512" fill="${BG}"/>
  <rect width="512" height="512" fill="url(#glow)"/>
  <g transform="translate(256,256) scale(${k}) translate(${-CX},${-CY})">
    <path d="${PLANE_PATH}" fill="${MARK}" stroke="rgba(0,0,0,0.55)" stroke-width="1.1"
          stroke-linejoin="round"/>
  </g>
</svg>`;
}

// Scale for an "any" icon: the dart occupies ~62% of the box height.
const K_ANY = (0.62 * 512) / 18;
// Maskable: keep the furthest corner inside the 80% safe circle (radius
// 0.4*512 = 204.8) with margin to spare.
const K_MASKABLE = (0.34 * 512) / HALF_DIAGONAL;

const ICONS = [
  { file: "icon-192.png", size: 192, k: K_ANY },
  { file: "icon-512.png", size: 512, k: K_ANY },
  { file: "icon-maskable-512.png", size: 512, k: K_MASKABLE },
  { file: "apple-touch-icon-180.png", size: 180, k: K_ANY },
];

mkdirSync(OUT_DIR, { recursive: true });

const launch = process.env.PW_CHROMIUM_PATH
  ? { executablePath: process.env.PW_CHROMIUM_PATH }
  : {};
const browser = await chromium.launch(launch);
const page = await browser.newPage({ deviceScaleFactor: 1 });

for (const { file, size, k } of ICONS) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<body style="margin:0;line-height:0">${svg(k).replace(
      'viewBox="0 0 512 512"',
      `viewBox="0 0 512 512" width="${size}" height="${size}"`,
    )}</body>`,
  );
  await page.screenshot({ path: join(OUT_DIR, file), clip: { x: 0, y: 0, width: size, height: size } });
  console.log(`wrote ${join("public/icons", file)} (${size}x${size})`);
}

await browser.close();
