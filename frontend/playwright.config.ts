import { defineConfig } from "@playwright/test";

// These tests never talk to the real backend — every request the app
// makes (REST, WebSocket) is intercepted and served from tests/fixtures/
// (real API responses captured once and replayed deterministically), so
// `webServer` only needs to boot the frontend itself. No docker-compose
// stack required to run this suite.
export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  reporter: "list",
  use: {
    baseURL: "http://localhost:5174",
    trace: "retain-on-failure",
  },
  // Two servers: the dev server every spec uses, and a real production
  // preview for production-build.spec.ts. That second one isn't
  // belt-and-braces — Vite's dev server and Rollup handle maplibre-gl's
  // worker differently, and a bug that only existed in the production
  // build reached production precisely because nothing here ever built
  // one. The build is a couple of seconds; reuseExistingServer keeps it
  // off the path when a preview is already up.
  webServer: [
    {
      command: "npm run dev -- --port 5174 --strictPort",
      url: "http://localhost:5174",
      reuseExistingServer: !process.env.CI,
    },
    {
      command: "npm run build && npx vite preview --port 4173 --strictPort",
      url: "http://localhost:4173",
      reuseExistingServer: !process.env.CI,
    },
  ],
});
