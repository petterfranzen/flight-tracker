import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";

// A local origin for the worker tests. It serves a built frontend from a
// directory and - crucially - can emit the app's security headers, which the
// Vite dev server and `vite preview` do not. That is the whole point: the
// worker only carries headers a server actually sent, so a test against
// vite preview cannot see whether a cached navigation kept them.
//
// The header values mirror backend SecurityHeadersFilter (whose own
// responsesCarrySecurityHeaders test pins the originals against a real
// Tomcat). Kept in step by hand; the CSP string is the same one sw.js
// carries for the offline fallback.

export const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "connect-src 'self' https://tiles.openfreemap.org",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "font-src 'self'",
  ].join("; "),
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
};

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
};

export interface ShellServer {
  /** Origin root, e.g. http://127.0.0.1:54321/ */
  url: string;
  /** Request count per pathname, so a test can prove a document did (or did not) reach the network. */
  hits: Map<string, number>;
  /** Serve from another directory (build A -> build B). */
  setDir(dir: string): void;
  close(): Promise<void>;
}

/**
 * Serves `dir` on a loopback port. `/` maps to /index.html. By default a path
 * that is not a real file 404s, so a navigation the worker wrongly answered
 * with the shell is visible as a 200 + #root rather than a 404. Set
 * `spaFallback` to mimic the jar (SpaWebConfig), which answers a missing file
 * with index.html and a 200.
 */
export async function startShellServer(
  dir: string,
  options: { securityHeaders?: boolean; spaFallback?: boolean } = {},
): Promise<ShellServer> {
  let root = dir;
  const hits = new Map<string, number>();
  const server = createServer(async (req, res) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    const file = pathname === "/" ? "/index.html" : pathname;
    hits.set(file, (hits.get(file) ?? 0) + 1);
    const headers: Record<string, string> = {
      "Cache-Control": "no-cache",
    };
    if (options.securityHeaders !== false) Object.assign(headers, SECURITY_HEADERS);
    try {
      const body = await readFile(path.join(root, file));
      headers["Content-Type"] = MIME[path.extname(file)] ?? "application/octet-stream";
      res.writeHead(200, headers);
      res.end(body);
    } catch {
      if (options.spaFallback) {
        // What SpaWebConfig does: a missing path falls back to index.html, 200.
        headers["Content-Type"] = "text/html; charset=utf-8";
        res.writeHead(200, headers);
        res.end(await readFile(path.join(root, "index.html")));
        return;
      }
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("not found");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/`,
    hits,
    setDir: (next) => {
      root = next;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
