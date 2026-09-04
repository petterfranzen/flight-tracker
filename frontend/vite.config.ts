import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // SPIKE (see MaplibreBasemap.tsx): maplibre-gl ships its renderer as a
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
  server: {
    proxy: {
      "/api": "http://localhost:8080",
      "/ws": { target: "ws://localhost:8080", ws: true }
    }
  }
});
