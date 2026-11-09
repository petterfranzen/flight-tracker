import { expect, test, type Page } from "@playwright/test";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mockFlightApi } from "./helpers";
import { startShellServer, type ShellServer } from "./sw-test-server";

// #181 review: the app-shell worker's contract, at the parts the vite-preview
// tests could not see.
//
//  - Security headers survive the cache. A navigation served from the worker
//    is the *stored server response*, so it must keep the CSP,
//    X-Frame-Options, nosniff, Referrer-Policy and Permissions-Policy that
//    SecurityHeadersFilter sets. `vite preview` sends none, which is why these
//    run against a server that does (see sw-test-server.ts, which mirrors the
//    filter's values).
//  - Only SPA routes are answered with the shell. Server-owned paths
//    (/oauth2/*, /login/*) must reach the network.
//  - A new build replaces the old cache: build A's skygrid-shell-* is gone,
//    exactly one remains, and it holds B's index.html and assets.

const DIST = path.resolve(process.cwd(), "dist");

/** Waits until this page is actually controlled by the worker. */
async function waitForControl(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
}

async function shellCacheNames(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    caches.keys().then((keys) => keys.filter((name) => name.startsWith("skygrid-shell-"))),
  );
}

test.describe("app-shell worker", () => {
  test.describe.configure({ timeout: 120_000 });

  test("a navigation served from the cache keeps the app's security headers", async ({ page }) => {
    const server = await startShellServer(DIST);
    try {
      await mockFlightApi(page);
      await page.goto(server.url);
      await waitForControl(page);

      // The reload is the first navigation a controlled page makes: the worker
      // answers it from its cache (the header asserts that), and the stored
      // response must still carry the server's headers.
      const response = await page.reload();
      expect(response?.status()).toBe(200);
      expect(response?.fromServiceWorker(), "the reload reached the network instead of the worker").toBe(true);

      const headers = response?.headers() ?? {};
      expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
      expect(headers["content-security-policy"]).toContain("script-src 'self'");
      expect(headers["x-frame-options"]).toBe("DENY");
      expect(headers["x-content-type-options"]).toBe("nosniff");
      expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
      expect(headers["permissions-policy"]).toContain("camera=()");
    } finally {
      await server.close();
    }
  });

  test("the offline fallback page carries the security headers too", async ({ page, context }) => {
    const server = await startShellServer(DIST);
    try {
      await mockFlightApi(page);
      await page.goto(server.url);
      await waitForControl(page);

      // No shell at all: drop the cache, then go offline. This is the one path
      // that generates the document itself (offlineFallback).
      await page.evaluate(async () => {
        for (const name of await caches.keys()) await caches.delete(name);
      });
      await context.setOffline(true);
      const response = await page.goto(server.url, { waitUntil: "domcontentloaded" });
      expect(response?.status()).toBe(200);
      expect(response?.fromServiceWorker()).toBe(true);

      const headers = response?.headers() ?? {};
      expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
      expect(headers["x-frame-options"]).toBe("DENY");
      expect(headers["x-content-type-options"]).toBe("nosniff");
      await expect(page.locator("main h1")).toHaveText("Offline");
    } finally {
      await context.setOffline(false);
      await server.close();
    }
  });

  test("only SPA routes are answered with the shell; server routes reach the network", async ({ page }) => {
    const server = await startShellServer(DIST);
    try {
      await mockFlightApi(page);
      await page.goto(server.url);
      await waitForControl(page);

      // Server-owned path (the #193 OAuth entry point): the worker must not
      // answer with the cached shell, so this reaches our server, which 404s.
      const response = await page.goto(`${server.url}oauth2/authorization/google`, { waitUntil: "domcontentloaded" });
      expect(response?.status()).toBe(404);
      expect(response?.fromServiceWorker()).toBe(false);
      expect(server.hits.get("/oauth2/authorization/google")).toBe(1);
      // The shell was not substituted: no SPA mount point in the served document.
      await expect(page.locator("#root")).toHaveCount(0);

      // ...whereas the SPA's own route is still answered from the worker's cache.
      const spa = await page.goto(server.url, { waitUntil: "domcontentloaded" });
      expect(spa?.status()).toBe(200);
      expect(spa?.fromServiceWorker()).toBe(true);
      await expect(page.locator("#root")).toHaveCount(1);
    } finally {
      await server.close();
    }
  });

  test("a missing icon is not cached as the SPA fallback HTML", async ({ page }) => {
    // The jar answers a missing file with index.html and a 200 (SpaWebConfig),
    // so without a content-type check the worker would store HTML under
    // /icons/ and later serve HTML for an image.
    const server = await startShellServer(DIST, { spaFallback: true });
    try {
      await mockFlightApi(page);
      await page.goto(server.url);
      await waitForControl(page);

      const status = await page.evaluate(async () => (await fetch("/icons/does-not-exist.png")).status);
      expect(status).toBe(200); // the server's SPA fallback, not a real icon

      const cached = await page.evaluate(async () => {
        const paths: string[] = [];
        for (const name of await caches.keys()) {
          const cache = await caches.open(name);
          for (const request of await cache.keys()) paths.push(new URL(request.url).pathname);
        }
        return paths;
      });
      expect(cached).not.toContain("/icons/does-not-exist.png");
    } finally {
      await server.close();
    }
  });

  test("a new build replaces the old shell cache", async ({ page }) => {
    const buildB = await makeBuildB();
    const server = await startShellServer(DIST);
    try {
      await mockFlightApi(page);
      await page.goto(server.url);
      await waitForControl(page);

      const first = await shellCacheNames(page);
      expect(first).toHaveLength(1);
      const nameA = first[0];

      // Swap build A for build B under the same origin. The next navigation is
      // answered from A's cache (stale-while-revalidate) and the background
      // revalidation rebuilds the shell from B.
      server.setDir(buildB);
      await page.reload();

      await expect
        .poll(async () => {
          const names = await shellCacheNames(page);
          return names.length === 1 && names[0] !== nameA ? names[0] : null;
        }, { timeout: 30_000 })
        .not.toBeNull();

      const names = await shellCacheNames(page);
      expect(names, "the old shell cache was not replaced").not.toContain(nameA);
      expect(names).toHaveLength(1);
      const nameB = names[0];

      // The new cache holds B's index.html and B's renamed entry asset.
      const cached = await page.evaluate(async (cacheName) => {
        const cache = await caches.open(cacheName);
        return (await cache.keys()).map((request) => new URL(request.url).pathname);
      }, nameB);
      expect(cached).toContain("/index.html");
      expect(cached.some((p) => /^\/assets\/b-.*\.js$/.test(p))).toBe(true);

      // And the page ends up running B.
      await page.reload();
      await expect(page).toHaveTitle("Skygrid build B");
    } finally {
      await server.close();
      await rm(buildB, { recursive: true, force: true });
    }
  });
});

/**
 * Build B: a copy of the built app whose index.html names renamed (/assets/b-*)
 * entry assets and carries a marker title. A different asset list is what
 * makes the worker derive a different cache name, and the title is what proves
 * the browser ended up on B.
 */
async function makeBuildB(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "skygrid-build-b-"));
  await cp(DIST, dir, { recursive: true });

  const indexPath = path.join(dir, "index.html");
  const html = await readFile(indexPath, "utf8");

  const names = new Set<string>();
  for (const match of html.matchAll(/\/assets\/([^"')\s]+)/g)) names.add(match[1]);
  for (const name of names) {
    await cp(path.join(dir, "assets", name), path.join(dir, "assets", `b-${name}`));
  }

  const rewritten = html
    .replace(/\/assets\/([^"')\s]+)/g, "/assets/b-$1")
    .replace(/<title>[^<]*<\/title>/, "<title>Skygrid build B</title>");
  await writeFile(indexPath, rewritten, "utf8");
  return dir;
}
