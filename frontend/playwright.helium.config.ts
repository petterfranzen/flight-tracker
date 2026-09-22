import { existsSync } from "node:fs";
import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

// Helium is our house browser for agent-driven UI testing — see CLAUDE.md.
// Never point this at Vivaldi; that's the human's daily-driver browser.
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
  // Helium is a real desktop browser, not the lightweight test-oriented
  // Chromium Playwright bundles — launching a dozen full instances at once
  // (base config's fullyParallel default) starves the machine and produces
  // exactly the symptom that looks like a broken app: page.goto timing out
  // across unrelated specs. One worker keeps this to one Helium instance
  // at a time, trading speed for actually finishing.
  workers: 1,
  use: {
    launchOptions: { executablePath },
  },
});
