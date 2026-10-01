import { existsSync } from "node:fs";
import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

// Helium is the browser for agent-driven UI testing on the human's own
// machines; see CLAUDE.md. Never point this at Vivaldi, which is the
// human's daily browser. Cloud sessions use playwright.config.ts directly.
const CANDIDATES = [
  process.env.HELIUM_PATH,
  "/Applications/Helium.app/Contents/MacOS/Helium", // macOS
  "/usr/bin/helium", // Linux package install
  "/opt/helium/helium", // Linux tarball install
].filter((path): path is string => !!path);

const executablePath = CANDIDATES.find(existsSync);

if (!executablePath) {
  throw new Error(
    "Helium executable not found. Set HELIUM_PATH or install it at one of: " +
      CANDIDATES.join(", "),
  );
}

export default defineConfig(base, {
  // Helium is a full desktop browser, not Playwright's lightweight
  // Chromium. Running one instance per worker (the base config is
  // fullyParallel) starves the machine, and page.goto starts timing out
  // across unrelated specs, which looks like a broken app. One worker keeps
  // it to a single Helium instance.
  workers: 1,
  use: {
    ...base.use,
    // Overrides any PW_CHROMIUM_PATH launch option from the base config.
    launchOptions: { executablePath },
  },
});
