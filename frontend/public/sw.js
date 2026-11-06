/*
 * Minimal service worker for Netwatch Skygrid.
 *
 * Deliberately NO cache and NO precache. Its two jobs:
 *
 *  1. Satisfy Chrome's install-prompt requirement. Chrome still requires a
 *     service worker with a fetch handler before it offers "Install app"
 *     (install-from-menu dropped that in 108/112, the prompt did not).
 *  2. Give the page registration.showNotification() on Android Chrome and
 *     on iOS home-screen installs, plus a notificationclick handler (#82's
 *     design asks for exactly this worker; #85 reuses it, never a second).
 *
 * The fetch listener does nothing: it never calls respondWith(), so every
 * request goes to the network exactly as if no worker existed. That is the
 * point — a cached shell here could keep a deploy's fix from reaching a
 * phone. index.html and the hashed assets are already served no-cache /
 * immutable by SpaWebConfig. There is therefore nothing to cache-bust and
 * no "new version, reload" prompt to build: a deploy's index.html is what
 * the next load fetches, because nothing intercepts it.
 */
self.addEventListener("install", () => {
  // No cache to warm, so waiting would only delay the update.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  // Take control of open pages immediately so the install prompt can fire
  // on this visit rather than the next one.
  event.waitUntil(self.clients.claim());
});

// Present but intentionally inert: no respondWith(), no caching. Chrome's
// install prompt requires a fetch handler to exist.
self.addEventListener("fetch", () => {});

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
