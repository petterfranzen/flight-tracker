# Installing Netwatch Skygrid as an app (PWA, #85)

The site can be installed to a phone's home screen and runs full-screen
(`display: standalone`). This note covers what ships, how to check it on a
real phone, and the production settings that matter.

## What ships

| Piece | File | Notes |
|---|---|---|
| Web app manifest | `frontend/public/manifest.json` | name **Netwatch Skygrid**, short name **Skygrid**, `start_url` and `scope` `/`, `display: standalone`. Colours are the cyberpunk tokens: `#050608` = `--color-bg` in `frontend/src/components/FlightMap.css`. |
| Icons | `frontend/public/icons/` | 192, 512, maskable 512, apple-touch-icon 180. Generated from the map's own plane dart (`PLANE_PATH` in `src/map/planes.ts`) by `npm run icons` (`scripts/generate-pwa-icons.mjs`). Re-run it if the mark or the cyberpunk tokens change. |
| iOS meta tags | `frontend/index.html` | `viewport-fit=cover`, `apple-mobile-web-app-capable`, apple-touch-icon, `theme-color`. No `apple-mobile-web-app-status-bar-style`: iOS 26.1+ deprecated `black-translucent` and draws a dark scrim over the status-bar area of an installed app, so the bar is left at its default (opaque, theme-coloured) style. |
| Service worker | `frontend/public/sw.js` | Minimal: **no cache and no precache**. It exists to satisfy Chrome's install-prompt requirement (a worker with a fetch handler must control the page) and to give #82's notifications `registration.showNotification()` on Android / installed iOS. Its fetch listener never calls `respondWith()`, so every request goes to the network exactly as before. |
| Install UI | `frontend/src/ui/installPrompt.ts` + `src/components/InstallPrompt.css` | Bottom-centre pill: "Install app" after `beforeinstallprompt` (Android/desktop Chrome), or the one-line Share > Add to Home Screen hint on iOS Safari. Dismissable and remembered in `localStorage`; hidden when already standalone and while a drawer/dossier is open. |
| Tests | `frontend/tests/pwa.spec.ts` | Manifest fields + every icon resolves as PNG; document links and iOS meta tags; worker registers and caches nothing; install pill appears only after the event and remembers a dismissal; iOS hint; hidden in standalone. |

### Why the worker caches nothing

The brief's warning is the design: a stale cached shell must never keep a fix
from reaching a phone. A worker that precaches `index.html` has to be
invalidated on every deploy and, if that goes wrong, serves yesterday's code.
This app's `index.html` and hashed assets are already served no-cache /
immutable by `SpaWebConfig`, so a deploy reaches the next load without help.
Caching nothing removes the failure mode entirely; the cost is no offline
shell. If offline support is ever wanted, add a cache with the `/api/health`
`version` (the git SHA) as the cache name and show a "new version, reload"
prompt on `controllerchange` — do not make the worker cache silently.

## Manual check list for Petter

### Android (Chrome)

1. Open the production URL in Chrome. Wait for the map to finish loading.
2. The "Install app" pill should appear at the bottom once Chrome decides the
   site is installable (it may take a visit or two; Chrome also offers
   ⋮ > Install app).
3. Tap **Install app** (or ⋮ > Install app). Confirm the prompt.
4. **What should happen:** a **Skygrid** icon appears on the home screen. Open
   it: the app launches full-screen with no address bar, the map fills the
   display, and the bottom sheet / scale bar sit above the home indicator.
5. Dismissal: tap **Not now**, reload the page. The pill stays hidden (the
   browser's own ⋮ > Install app is still there if you change your mind).
6. Already installed: open the home-screen app. No install pill appears.

### iPhone (Safari only)

1. Open the production URL in **Safari** (Chrome/Firefox on iOS cannot add to
   the home screen).
2. A one-line hint appears at the bottom: *"Install on iPhone: tap Share, then
   Add to Home Screen."* Dismiss it with **×** if you like; it is remembered.
3. Tap **Share** (the square with the up arrow) → **Add to Home Screen** →
   **Add**.
4. **What should happen:** a **Skygrid** icon appears. Open it: full-screen,
   the status bar is a solid strip in the app's dark theme colour (no dim band
   over the map), and the map and bottom sheet clear the notch and the home
   indicator.
5. Already installed: opening from the home screen shows no hint or pill.

### Both orientations

Check portrait and landscape. The notch must not cover the top-left controls,
the tracked chip, or the legend; the home indicator must not cover the bottom
sheet, the scale bar, the attribution, or the install pill. Measured at
390 x 844 and 844 x 390 with simulated insets: no violations after the CSS
fixes (`env(safe-area-inset-*)` on the overlay stack, tracked chip, app header,
dossier panel, full-screen drawers, dock, and MapLibre's bottom controls).

## Production configuration to check

1. **Manifest MIME type.** The manifest is named `manifest.json` deliberately.
   Spring's bundled `mime.types` has no `webmanifest` entry, so a
   `.webmanifest` file would be served as `application/octet-stream` and Chrome
   would reject it. `.json` is served as `application/json`, which Chrome,
   Firefox and Safari accept for a manifest. If you prefer the spec name,
   rename it and register a servlet MIME mapping for `webmanifest` →
   `application/manifest+json` first.
2. **No-cache headers.** `SpaWebConfig` serves `/**` with `CacheControl.noCache()`
   and `/assets/**` immutable. That covers `/sw.js` and `/manifest.json`, so a
   deploy's worker and manifest are revalidated on the next load. Do not add a
   long cache for either.
3. **Cloudflare Tunnel.** The app is served at the tunnel root, so `scope: "/"`
   and `start_url: "/"` are correct. HTTPS is provided by Cloudflare and is
   required for a service worker. If a Cloudflare Cache Rule ever caches
   "Everything", add a bypass for `/sw.js` and `/manifest.json` so worker
   updates are not delayed at the edge. The default "Respect Existing Headers"
   already leaves them uncached because the origin sends no-cache.
4. **CSP.** No Content-Security-Policy is set today. If one is added later, it
   must allow `worker-src 'self'` (or `child-src`) and `manifest-src 'self'`,
   or the worker and manifest will be blocked.
5. **Subpath deployments.** If the app is ever served under a path prefix
   instead of the tunnel root, update `start_url`, `scope`, the manifest
   `id`, and the worker registration path together.
6. **Theme changes.** `manifest.json` and the `theme-color` meta carry the
   literal `#050608` (`--color-bg`). If the cyberpunk token changes, update
   both by hand; JSON and meta tags cannot read CSS variables. The icon
   generator's `BG`/`MARK` constants also mirror the tokens.
