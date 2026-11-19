// Soak settings, read once from the environment (see README "Configuration"),
// plus the small helpers every soak module shares.

import path from "node:path";
import { fileURLToPath } from "node:url";

// Resolve repo-relative defaults (the jar) against the repo root, not the
// caller's cwd, so `node blackbox-tests/soak/soak.mjs` and running from inside
// the soak directory both find the same jar.
export const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..");
export const resolveRepo = (p) => (path.isAbsolute(p) ? p : path.resolve(REPO_ROOT, p));

const num = (name, fallback) => {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    console.error(`${name} must be a number, got ${JSON.stringify(raw)}`);
    process.exit(2);
  }
  return n;
};
const str = (name, fallback) => {
  const raw = process.env[name];
  return raw === undefined || raw.trim() === "" ? fallback : raw.trim();
};

export const cfg = {
  mode: str("SOAK_MODE", "local"), // local: spawn jar + mock; external: clients only
  baseUrl: str("SOAK_BASE_URL", "http://127.0.0.1:18080").replace(/\/+$/, ""),
  jar: str("SOAK_JAR", "backend/target/flight-tracker.jar"),
  port: num("SOAK_PORT", 18080),
  mockPort: num("SOAK_MOCK_PORT", 18099),
  aircraft: num("SOAK_AIRCRAFT", 12000),
  clients: num("SOAK_CLIENTS", 100),
  pollSeconds: num("SOAK_POLL_SECONDS", 18),
  globalSweepSeconds: num("SOAK_GLOBAL_SWEEP_SECONDS", 360),
  durationSeconds: num("SOAK_DURATION_SECONDS", 900),
  warmupSeconds: num("SOAK_WARMUP_SECONDS", 90),
  startTimeoutSeconds: num("SOAK_START_TIMEOUT_SECONDS", 300),
  stopTimeoutSeconds: num("SOAK_STOP_TIMEOUT_SECONDS", 25),
  rssSampleMs: num("SOAK_RSS_SAMPLE_MS", 5000),
  view: {
    latMin: num("SOAK_VIEW_LAT_MIN", 45),
    latMax: num("SOAK_VIEW_LAT_MAX", 55),
    lonMin: num("SOAK_VIEW_LON_MIN", 5),
    lonMax: num("SOAK_VIEW_LON_MAX", 20),
  },
  java: str("SOAK_JAVA", process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, "bin", "java") : "java"),
  xmx: str("SOAK_XMX", "1g"),
  maxP95Ms: num("SOAK_MAX_P95_MS", 0),
  maxRssMb: num("SOAK_MAX_RSS_MB", 0),
  minDeliveryRatio: num("SOAK_MIN_DELIVERY_RATIO", 0),
  keepDb: str("SOAK_KEEP_DB", "0") === "1",
  out: str("SOAK_OUT", "soak-report.json"),
  appLogOut: str("SOAK_APP_LOG", "soak-app.log"),
};

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const stamp = () => new Date().toISOString();
export const log = (...a) => console.log(`[soak ${stamp()}]`, ...a);

/** Rounds to `places` decimals the way the report always has. */
export const round = (n, places) => Math.round(n * 10 ** places) / 10 ** places;

/** The viewport query string GET /api/flights/live takes. */
export const viewQuery = (v) => `latMin=${v.latMin}&latMax=${v.latMax}&lonMin=${v.lonMin}&lonMax=${v.lonMax}`;
