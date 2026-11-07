/*
 * Service worker for Netwatch Skygrid: a cached app shell, and nothing else.
 *
 * What it does
 *   - Precaches the app shell (index.html, the hashed JS/CSS the build's
 *     index.html references, the manifest and the icons) and serves those
 *     cache-first, so a cold open with no network paints the real UI instead
 *     of the browser's error page.
 *   - Keeps the cached shell current: a navigation is answered from the cache
 *     at once and then revalidated in the background (stale-while-revalidate).
 *     If the revalidated index.html is a new build, the shell is rebuilt under
 *     a new content-derived cache name and the previous cache is deleted.
 *   - Also caches, on first use, the content-hashed files the app pulls in at
 *     runtime (the MapLibre worker chunk, the bundled webfonts): they are
 *     immutable per hash, so cache-first can never serve a stale one.
 *
 * What it deliberately never touches
 *   - `/api/*` and `/ws*`: the fetch handler returns without calling
 *     respondWith(), so those requests pass straight to the network and are
 *     never cached. Live data must never come from a cache.
 *   - Basemap tiles (tiles.openfreemap.org): cross-origin, and their terms
 *     and the app's CSP forbid us holding them. Anything cross-origin is left
 *     to the network.
 *
 * Versioning / update path
 *   The cache name is `skygrid-shell-<hash of the shell's asset list>`, so a
 *   deploy that changes the bundle lands under a new name and `activate` (and
 *   the background revalidation) deletes the old one. `skipWaiting()` on
 *   install plus `clients.claim()` on activate mean a new worker takes over at
 *   once instead of waiting for every tab to close. That is safe here: the
 *   cached shell is content-addressed and only ever served for a navigation,
 *   which is then revalidated, so claiming immediately can at worst leave one
 *   already-open tab on the shell it loaded — the next navigation gets the new
 *   one. There is no "new version, reload?" prompt because nothing is trapped.
 */

const SHELL_PREFIX = "skygrid-shell-";

// Bump when this file's own shell rules change, so an update still lands when
// the build's asset hashes happen to be unchanged.
const SHELL_RULES_VERSION = "1";

const SHELL_URLS = [
  "/manifest.json",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-maskable-512.png",
  "/icons/apple-touch-icon-180.png",
];

const HTML_HEADERS = { "Content-Type": "text/html; charset=utf-8" };

/** Requests that must always go straight to the network, never be cached. */
function isLiveData(pathname) {
  return pathname.startsWith("/api/") || pathname === "/api" || pathname.startsWith("/ws") || pathname === "/ws";
}

/** The same-origin, cacheable shell files the build's index.html references. */
function shellAssets(html) {
  const out = new Set();
  const re = /(?:src|href)\s*=\s*["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const u = m[1];
    if (u.startsWith("/assets/") || u.startsWith("/icons/") || u === "/manifest.json") out.add(u);
  }
  return [...out];
}

/** A short content hash of the shell's asset list, so a new build gets a new cache name. */
function shellVersion(html) {
  const list = shellAssets(html).concat(SHELL_URLS).sort().join("|");
  let h = 0x811c9dc5;
  for (let i = 0; i < list.length; i += 1) {
    h ^= list.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36) + "-" + SHELL_RULES_VERSION;
}

// A quoted or url() token that names a built file. Rollup's output imports its
// chunks by relative path and the bundled CSS references its webfonts the same
// way, so the shell's real file set is only found by following those edges.
// Rollup emits dynamic imports as backtick template literals (`./chunk.js`),
// static ones as "..." or '...', and the bundled CSS references its webfonts
// with url(...): all three delimiters are in the class below.
const ASSET_REF_RE = /["'(`]\s*([^"'`)]+?\.(?:js|mjs|css|woff2?|woff|png|svg))\s*["')`]/g;
const MAX_SHELL_FILES = 80;

/**
 * Fetches every built file reachable from `seeds` (the entry chunks
 * index.html names, then whatever those import or reference) and returns
 * [url, response] pairs. This is what makes a cold offline open work: the
 * lazy route chunks (defaultAirports, watchedAirports, worldMapData) are not
 * in index.html, and on a first visit the page loads before the worker
 * controls it, so they would otherwise never be cached.
 */
async function collectShellAssets(seeds) {
  const seen = new Set();
  const found = [];
  const queue = [...seeds];
  while (queue.length > 0 && found.length < MAX_SHELL_FILES) {
    const url = queue.shift();
    if (!url || seen.has(url) || url.startsWith("http") || url.startsWith("data:")) continue;
    if (!url.startsWith("/") && !url.startsWith("./") && !url.startsWith("../")) continue;
    if (url === "/sw.js") continue; // never store the worker itself in the shell cache
    seen.add(url);
    let res;
    try {
      res = await fetch(url);
    } catch {
      continue;
    }
    if (!res || !res.ok) continue;
    found.push([url, res]);
    const type = res.headers.get("content-type") || "";
    if (!/javascript|css/.test(type)) continue;
    let text;
    try {
      text = await res.clone().text();
    } catch {
      continue;
    }
    const base = new URL(url, self.location.origin);
    ASSET_REF_RE.lastIndex = 0;
    let m;
    while ((m = ASSET_REF_RE.exec(text)) !== null) {
      const ref = m[1];
      if (ref.startsWith("http") || ref.startsWith("data:") || ref.startsWith("#")) continue;
      if (!ref.startsWith("/") && !ref.startsWith("./") && !ref.startsWith("../")) continue;
      try {
        queue.push(new URL(ref, base).pathname);
      } catch {
        // Not a path we can resolve: skip it.
      }
    }
  }
  return found;
}

/** The single shell cache that currently exists, opened. */
async function shellCache() {
  const keys = (await caches.keys()).filter((k) => k.startsWith(SHELL_PREFIX));
  return caches.open(keys[0] || SHELL_PREFIX + "empty");
}

/** Builds (or refreshes) the shell cache from an index.html response, and drops older shell caches. */
async function buildShell(response) {
  if (!response || !response.ok) return null;
  const html = await response.clone().text();
  const name = SHELL_PREFIX + shellVersion(html);
  const cache = await caches.open(name);
  await cache.put("/index.html", new Response(html, { headers: HTML_HEADERS }));
  // Stored with clone(): the walker already read a clone of the JS/CSS ones,
  // and slice() refuses a body that has been teed, so clone() is the form that
  // works for every file here.
  const files = await collectShellAssets(SHELL_URLS.concat(shellAssets(html)));
  await Promise.all(
    files.map(async ([url, res]) => {
      try {
        await cache.put(url, res.clone());
      } catch {
        // A response that cannot be stored (opaque, already consumed): skip it,
        // the rest of the shell still goes in.
      }
    }),
  );
  for (const key of await caches.keys()) {
    if (key.startsWith(SHELL_PREFIX) && key !== name) await caches.delete(key);
  }
  return name;
}

/** A themed last-resort page for the one case with no cached shell at all: a first-ever visit that is offline. */
function offlineFallback() {
  const html = `<!doctype html><html lang="en" data-theme="cyberpunk"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Netwatch Skygrid</title>` +
    `<style>html,body{margin:0;height:100%}body{background:#050608;color:#eaf3fb;` +
    `font:15px/1.5 "JetBrains Mono","Courier New",monospace;display:grid;place-items:center;text-align:center}` +
    `main{max-width:32rem;padding:2rem;border:1px solid #ff4d5e;border-radius:8px}` +
    `h1{font-size:1.1rem;letter-spacing:.08em;text-transform:uppercase;margin:0 0 .5rem}` +
    `p{color:#a7b4c2;margin:0}</style></head><body><main><h1>Offline</h1>` +
    `<p>Live data unavailable. Reconnect to start Netwatch Skygrid.</p></main></body></html>`;
  return new Response(html, { status: 200, headers: HTML_HEADERS });
}

/** Cache-first for the shell files: instant when cached, network (and cache) otherwise. */
async function cacheFirst(request) {
  const cache = await shellCache();
  // Matched by URL, not by the Request: the server sends `Vary: Origin` on the
  // built assets (vite preview and the jar both do), and the fetch event's
  // Request carries an Origin header the entry stored by the precache (a plain
  // fetch, no Origin) does not, so matching the Request object misses a cache
  // the URL matches outright.
  const cached = await cache.match(request.url);
  if (cached) return cached;
  try {
    const res = await fetch(request);
    // Stored under the URL, so a later match (also by URL) never trips on the
    // response's own Vary header.
    if (res && res.ok && res.type === "basic") await cache.put(request.url, res.clone());
    return res;
  } catch {
    return Response.error();
  }
}

/** Stale-while-revalidate for a navigation: serve the cached shell now, refresh it in the background. */
async function handleNavigation(event) {
  const cache = await shellCache();
  const cached = await cache.match("/index.html");
  const revalidate = fetch("/index.html", { cache: "no-cache" })
    .then((res) => buildShell(res))
    .catch(() => null);
  if (cached) {
    event.waitUntil(revalidate);
    return cached;
  }
  // Nothing cached yet (first load): wait for the network, then the fresh shell.
  const built = await revalidate;
  const fresh = built ? await (await caches.open(built)).match("/index.html") : null;
  if (fresh) return fresh;
  return offlineFallback();
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      try {
        await buildShell(await fetch("/index.html", { cache: "no-cache" }));
      } catch {
        // Offline install: no shell to warm yet; the first online navigation builds it.
      }
      // Only after the shell is ready, so a new worker is never serving an empty cache.
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Exactly one shell cache: drop any stragglers (a crashed install, an old name).
      const keys = (await caches.keys()).filter((k) => k.startsWith(SHELL_PREFIX));
      if (keys.length > 1) {
        for (const key of keys.slice(1)) await caches.delete(key);
      }
      // Take control of open pages immediately (see the header): the install
      // prompt can then fire on this visit, and a deploy's shell is picked up
      // by the next navigation rather than the next launch.
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }

  // Cross-origin (basemap tiles, TileJSON, fonts): network, never cached.
  if (url.origin !== self.location.origin) return;

  // Live data: pass straight through, never intercepted and never cached.
  if (isLiveData(url.pathname)) return;

  if (request.mode === "navigate") {
    event.respondWith(handleNavigation(event));
    return;
  }

  // The shell's static files, plus anything the build emits under /assets/
  // (its JS/CSS, the MapLibre worker chunk, the bundled webfonts).
  if (url.pathname.startsWith("/assets/") || url.pathname.startsWith("/icons/") || url.pathname === "/manifest.json") {
    event.respondWith(cacheFirst(request));
  }
  // Everything else same-origin: as if no worker existed.
});

// #82's notification click: focus an existing tab if there is one.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ("focus" in client) return client.focus();
      }
      return self.clients.openWindow("/");
    }),
  );
});
