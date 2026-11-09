# Installing Netwatch Skygrid as an app (PWA, #85)

The site can be installed to a phone's home screen and runs full-screen
(`display: standalone`). This note covers what ships, how to check it on a
real phone, and the production settings that matter.

## What ships

| Piece | File | Notes |
|---|---|---|
| Web app manifest | `frontend/public/manifest.json` | name **Netwatch Skygrid**, short name **Skygrid**, `start_url` and `scope` `/`, `display: standalone`. Colours are the cyberpunk tokens: `#050608` = `--color-bg` in `frontend/src/components/FlightMap.css`. |
| Icons | `frontend/public/icons/` | 192, 512, maskable 512, apple-touch-icon 180. Generated from the map's own plane dart (`PLANE_PATH` in `src/map/planes.ts`) by `npm run icons` (`scripts/generate-pwa-icons.mjs`). Re-run it if the mark or the cyberpunk tokens change. |
| iOS meta tags | `frontend/index.html` | `viewport-fit=cover`, `apple-mobile-web-app-capable`, `black-translucent` status bar, apple-touch-icon, `theme-color`. |
| Service worker | `frontend/public/sw.js` | An offline **app shell** cache, and a pass-through for everything live (#181, reviewed #182). It precaches the build's shell (index.html, the hashed assets index.html imports — lazy chunks, worker bundle and webfonts included — the manifest and the icons) and serves it cache-first, so a cold open with no network paints the real UI. `/api/*`, `/ws*` and all cross-origin traffic (basemap tiles) are never intercepted or cached; a **cached navigation is the stored server response and keeps its security headers**; only **SPA routes** are answered with the shell (server paths like `/oauth2/*` reach the network); keys are versioned by the shell's content, and the old cache is dropped only once the new shell is **complete**. Registered only in the production build. It also gives #82's notifications `registration.showNotification()` on Android / installed iOS. |
| Install UI | `frontend/src/ui/installPrompt.ts` + `src/components/InstallPrompt.css` | Bottom-centre pill: "Install app" after `beforeinstallprompt` (Android/desktop Chrome), or the one-line Share > Add to Home Screen hint on iOS Safari. Dismissable and remembered in `localStorage`; hidden when already standalone and while a drawer/dossier is open. |
| Tests | `frontend/tests/pwa.spec.ts`, `frontend/tests/sw.spec.ts`, `frontend/tests/offline.spec.ts` | Manifest fields + every icon resolves as PNG; document links and iOS meta tags; worker registers in the production build only and caches no `/api` or `/ws`; install pill appears only after the event and remembers a dismissal; iOS hint; hidden in standalone. `sw.spec.ts` runs the worker against a local origin that sends the app's headers: a cached navigation and the offline fallback keep CSP / X-Frame-Options / nosniff; only SPA routes are answered with the shell; a new build replaces the old cache; a missing icon is not cached as HTML. `offline.spec.ts` covers the app's own offline state. |

### What the worker caches, and what it must never cache

The rule the worker is built around (#181): **live data is never served from a
cache.** A stale plane position is worse than no plane, so `/api/*` and `/ws*`
are not intercepted, not stored, and have no fallback response — the fetch
listener returns before `respondWith()`, and the request goes to the network
exactly as if no worker existed. Basemap tiles (`tiles.openfreemap.org`) are
cross-origin and are left to the network too: they are not ours to cache and
the CSP keeps them out of our origin.

Everything else is the **app shell**, and it is cached:

- what is precached: `index.html`, every built file reachable from it by
  following imports (the content-hashed JS/CSS, the lazy route chunks, the
  MapLibre worker bundle, the bundled webfonts), `manifest.json` and the icons;
- how it is served: cache-first. A navigation is answered from the cache at
  once and then revalidated in the background (stale-while-revalidate), so the
  shell never blocks on a slow network; `/assets/*`, `/icons/*` and the
  manifest come from the cache when present and are cached on first use.

**Cache versioning.** The cache name is `skygrid-shell-<hash of the shell's
asset list>`, so a deploy that changes the bundle lands under a new name. The
old caches are deleted when the new worker activates, and again whenever a
revalidation finds a changed `index.html` — so a deploy replaces the old shell
rather than sitting beside it. Bump `SHELL_RULES_VERSION` in `sw.js` when the
worker's own rules change (and note it in the release checklist, since a change
to the shell rules alone would otherwise not move the cache name).

**An incomplete new shell never replaces a complete old one.** `buildShell`
stores every entry asset index.html names (plus the manifest and icons) and, if
any of them could not be fetched, leaves the old cache in place rather than
swapping in a half-built shell. A flaky moment during revalidation therefore
costs you freshness, not the offline app.

**Security headers survive the cache.** A navigation served from the worker is
the *stored server response* — headers and all — so it keeps the CSP,
`X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy` and
`Permissions-Policy` that `SecurityHeadersFilter` sets. The generated offline
fallback page carries the same set explicitly (`SECURITY_HEADERS` in `sw.js`).
These values are a hand-kept copy of the backend filter; the backend test
`SecurityHeadersAndOriginTest` pins the originals, and `frontend/tests/
sw.spec.ts` runs against a local origin that sends them, which is what the
`vite preview` suite could not see.

**Only SPA routes get the shell.** The fetch handler answers a navigation from
the cache only for `/` and `/index.html` (the SPA's own routes). Everything
else the server owns — `/oauth2/authorization/*` and `/login/oauth2/code/*`
from #193, actuator paths, files — reaches the network as if no worker existed.
Without that a cached shell would swallow the social-login redirects.

**A missing file is not cached as the shell.** `SpaWebConfig` answers a missing
path with `index.html` and a 200, so `cacheFirst` checks the response's
`content-type` against the path before storing it — a missing icon is served
(HTML, wrongly, by the server) but never cached under `/icons/`.

**The update path.** `install` calls `skipWaiting()` (after the shell is
built) and `activate` calls `clients.claim()`, so a new worker takes over
immediately instead of waiting for every tab to close, and the install prompt
can fire on the same visit. That is safe here precisely because the cached
shell is content-addressed and only ever served for a navigation, which is then
revalidated: claiming at once can at worst leave one already-open tab on the
shell it loaded, and the *next* navigation gets the new one. Nothing is
trapped, so there is no "new version, reload?" prompt to build.

The cost of caching the shell at all is the one this design does not pay: a
cached `index.html` that is never revalidated. Stale-while-revalidate plus the
content-derived cache name is what keeps that from happening.

## Emergency kill switch

If the shell cache ever needs to be turned off in the field, it is **one
deploy** (two changes in the same build):

1. Build with `VITE_SW_DISABLED=true`. `main.ts` then stops calling
   `navigator.serviceWorker.register`, so no new client installs the worker.
2. Copy `frontend/public/sw-kill.js` over `frontend/public/sw.js`. A client
   with an existing registration revalidates `/sw.js` on its next navigation
   (`SpaWebConfig` serves it no-cache) and installs the kill worker, which
   deletes every `skygrid-shell-*` cache, unregisters itself and reloads any
   open page so it is no longer controlled. With registration already off, the
   reloaded page does not install a worker again — no loop.

To bring the shell back, revert the build (drop the flag, restore `sw.js`;
bump `SHELL_RULES_VERSION`) and deploy.

## Registering only in production

Registration is gated on `import.meta.env.PROD` in `main.ts`, so the worker
runs in the built bundle (the jar, `vite preview`) and never under the Vite
dev server, where a cached shell would hide HMR and serve stale code. The
worker's own tests (`pwa.spec.ts`, `sw.spec.ts`) therefore run against a
production build, not the dev server.

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
7. **Offline (#181).** With the app loaded once (so the shell is cached), turn
   the phone's network off and open the app again. **What should happen:** the
   UI still paints (no browser error page), a red-bordered *"Offline — live
   data unavailable"* banner sits at the top, and any aircraft already drawn are
   **dimmed** — never left looking live. Turn the network back on: the banner
   disappears and the map picks the live feed up again; no reload needed.

### iPhone (Safari only)

1. Open the production URL in **Safari** (Chrome/Firefox on iOS cannot add to
   the home screen).
2. A one-line hint appears at the bottom: *"Install on iPhone: tap Share, then
   Add to Home Screen."* Dismiss it with **×** if you like; it is remembered.
3. Tap **Share** (the square with the up arrow) → **Add to Home Screen** →
   **Add**.
4. **What should happen:** a **Skygrid** icon appears. Open it: full-screen,
   black-translucent status bar, map and bottom sheet clear the notch and the
   home indicator.
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
4. **CSP.** The app now ships one (`SecurityHeadersFilter`): it already allows
   `worker-src 'self' blob:`, `manifest-src 'self'` and `connect-src 'self'`,
   which is everything this worker needs. If the policy is ever tightened, those
   three directives must keep the worker, the manifest and the same-origin
   fetches working.
5. **The shell cache and `Vary`.** The built assets are served with `Vary:
   Origin`, so the worker matches its cache by URL rather than by the request
   object (a request object carrying an `Origin` header would miss an entry
   stored without one). Keep that in mind if the fetch handler is reworked.
6. **Subpath deployments.** If the app is ever served under a path prefix
   instead of the tunnel root, update `start_url`, `scope`, the manifest
   `id`, and the worker registration path together.
7. **Theme changes.** `manifest.json` and the `theme-color` meta carry the
   literal `#050608` (`--color-bg`). If the cyberpunk token changes, update
   both by hand; JSON and meta tags cannot read CSS variables. The icon
   generator's `BG`/`MARK` constants also mirror the tokens.
