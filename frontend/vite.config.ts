import { defineConfig } from "vite";

export default defineConfig({
  // See src/map/maplibreBasemap.ts: maplibre-gl ships its renderer as a
  // web worker it loads by URL at runtime. Vite's dep pre-bundler rewrites
  // the package but doesn't emit that worker into .vite/deps, so the
  // request 404s (net::ERR_FAILED on maplibre-gl-worker.mjs) and the map
  // paints its background color and nothing else — no tiles, no error the
  // page itself surfaces. Excluding it from pre-bundling makes Vite serve
  // the package's own ESM, worker included. Dev-only concern: the
  // production build (rollup) handles the worker correctly either way.
  optimizeDeps: { exclude: ["maplibre-gl"] },
  // maplibre constructs its worker with { type: "module" }, so the worker
  // bundle Vite emits for it (see MaplibreBasemap.tsx's ?worker&url import)
  // has to be an ES module too — Vite's default here is "iife".
  worker: { format: "es" },
  // maplibre-gl is a static import of the main bundle (the map is MapLibre
  // throughout), but kept in a chunk of its own: it is most of the bytes and
  // changes far less often than the app, so a deploy doesn't re-download it.
  build: {
    chunkSizeWarningLimit: 1_000,
    rollupOptions: { output: { manualChunks: { maplibre: ["maplibre-gl"] } } },
  },
  server: {
    proxy: {
      "/api": "http://localhost:8080",
      "/ws": { target: "ws://localhost:8080", ws: true }
    }
  }
});
