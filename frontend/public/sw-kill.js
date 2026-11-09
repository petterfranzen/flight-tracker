/*
 * Emergency kill switch for the Skygrid shell worker (#181).
 *
 * To disable the offline shell in production, in one deploy:
 *   1. build with VITE_SW_DISABLED=true  (so main.ts stops registering), and
 *   2. copy this file over public/sw.js  and ship it.
 *
 * Every client with a registration revalidates /sw.js (SpaWebConfig serves it
 * no-cache) on its next navigation, installs this in place of the shell
 * worker, which deletes the shell caches, unregisters itself and reloads any
 * open page so it is no longer controlled. With registration already off, the
 * reloaded page does not install a worker again - no loop. See
 * docs/agents/pwa-install.md, "Emergency kill switch".
 */
self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        if (key.startsWith("skygrid-shell-")) await caches.delete(key);
      }
      await self.registration.unregister();
      const clients = await self.clients.matchAll({ type: "window" });
      for (const client of clients) {
        if ("navigate" in client) client.navigate(client.url);
      }
    })(),
  );
});
