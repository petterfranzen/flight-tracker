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
  webServer: {
    command: "npm run dev -- --port 5174 --strictPort",
    url: "http://localhost:5174",
    reuseExistingServer: !process.env.CI,
  },
});
