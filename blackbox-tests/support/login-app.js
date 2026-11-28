// Spawns a *second* flight-tracker jar with the social-login flag on, pointed at
// the suite's hermetic fake OIDC provider (social login step 4, task 2). The jar
// the rest of the suite talks to -- `support/config.js`, port 8080 -- is left
// alone: this app is configured entirely through its environment, on its own
// loopback port, so a test can drive a real login round-trip without touching a
// running instance and without colliding on the default port.
//
// Contract: `startLoginApp({ fake })` resolves once `/api/health` answers, with
//   { baseUrl, port, logPath, stop }
// `fake` is the object `startFakeOidc()` returns; its `issuer` is what every
// GOOGLE_*_URI env var below is built from. `stop()` (SIGTERM) is safe to call
// twice and is also registered on `process.on("exit")`, so a runner that dies
// mid-test does not leave a jar behind.
//
// The OAuth client the jar registers must be the same one the fake provider was
// started with, or the id_token's `aud` will not match and the login is
// rejected. The fake does not hand its client id back, so it is exported here
// and both sides read the same constant: `startFakeOidc({ clientId: LOGIN_CLIENT_ID })`.
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The repo root, resolved from this file so the jar is found wherever the suite runs from. */
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** The OAuth client id the jar registers, and the one the fake provider must be started with. */
export const LOGIN_CLIENT_ID = "bb-login-client";

/** Any non-empty value is enough: the fake records client auth, it never verifies it. */
const LOGIN_CLIENT_SECRET = "bb-login-secret";

/**
 * The pepper the app hashes provider subjects with, which it refuses to start
 * without once the profile flag is on. Test-only, exactly like the secret above:
 * production sets its own from its environment and it never lives in the repo.
 */
const LOGIN_SUBJECT_PEPPER = "bb-login-subject-pepper";

/** Where the jar usually is: CI downloads the artifact to dist/, a local Maven build lands in target/. */
const JAR_CANDIDATES = ["dist/flight-tracker.jar", "backend/target/flight-tracker.jar"];

const HEALTH_TIMEOUT_MS = 90_000;
const HEALTH_POLL_MS = 500;
/** Enough of the boot log to see the stack trace or the port clash, not the whole boot. */
const LOG_TAIL_BYTES = 4_096;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The jar to spawn: `$FT_JAR` when set, else the CI artifact, else the local
 * Maven build. `null` when nothing is there -- the caller decides whether that
 * is a skip (a local run with no jar built) or a failure (CI, where a missing
 * artifact is the bug).
 */
export function resolveJar() {
  const explicit = process.env.FT_JAR?.trim();
  if (explicit) {
    if (!existsSync(explicit)) {
      throw new Error(`FT_JAR points at a file that does not exist: ${explicit}`);
    }
    return explicit;
  }
  return JAR_CANDIDATES.map((relative) => join(REPO_ROOT, relative)).find(existsSync) ?? null;
}

/** A free loopback port: bound and released, so the jar can have it. */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/**
 * The jar's whole configuration, as environment variables. Everything the
 * feature needs is set explicitly and nothing is carried in that could point it
 * elsewhere: no `FLIGHTTRACKER_PUBLIC_BASE_URL`, so the OAuth redirect URI falls
 * back to Spring's `{baseUrl}` placeholder and resolves to this jar's own
 * loopback origin -- exactly what the fake provider sends the browser back to.
 */
function appEnv({ port, workDir, fake }) {
  const env = { ...process.env };
  delete env.FLIGHTTRACKER_PUBLIC_BASE_URL;
  delete env.BASE_URL; // the shared jar's target; meaningless here and best not carried in
  delete env.GITHUB_CLIENT_ID;
  delete env.GITHUB_CLIENT_SECRET;
  Object.assign(env, {
    FLIGHTTRACKER_PROFILE_ENABLED: "true",
    FLIGHTTRACKER_SUBJECT_PEPPER: LOGIN_SUBJECT_PEPPER,
    GOOGLE_CLIENT_ID: LOGIN_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: LOGIN_CLIENT_SECRET,
    GOOGLE_AUTHORIZATION_URI: `${fake.issuer}/authorize`,
    GOOGLE_TOKEN_URI: `${fake.issuer}/token`,
    GOOGLE_JWK_SET_URI: `${fake.issuer}/jwks`,
    GOOGLE_ISSUER_URI: fake.issuer,
    SESSION_COOKIE_SECURE: "false", // the jar is reached over plain http on loopback
    SERVER_PORT: String(port),
    SERVER_ADDRESS: "127.0.0.1",
    TRUST_LOCAL: "true",
    FLIGHTTRACKER_DB_PATH: join(workDir, "ft.db"),
    FLIGHTTRACKER_AGENTS_OPENSKY_ENABLED: "false", // a login test is not a data-source test
  });
  return env;
}

/** The last few kB of the jar's own log, for a failure message that says why it never came up. */
function logTail(logPath) {
  try {
    const text = readFileSync(logPath, "utf8");
    return `--- last ${LOG_TAIL_BYTES} bytes of ${logPath} ---\n${text.slice(-LOG_TAIL_BYTES)}`;
  } catch {
    return "(no jar log captured)";
  }
}

async function isHealthy(healthUrl) {
  try {
    return (await fetch(healthUrl, { signal: AbortSignal.timeout(2_000) })).ok;
  } catch {
    return false; // not listening yet, or still starting
  }
}

function hasExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

/** Why the jar can no longer come up (it failed to spawn or it exited), or null while it still might. */
function startupFailure({ child, healthUrl, spawnError }) {
  const err = spawnError();
  if (err) {
    return `could not start the jar: ${err.message}`;
  }
  if (hasExited(child)) {
    return `the jar exited (code ${child.exitCode}, signal ${child.signalCode}) before ${healthUrl} answered`;
  }
  return null;
}

/** Polls `/api/health` until it answers or the deadline passes; every failure path carries the log tail. */
async function waitForHealth({ baseUrl, child, logPath, spawnError }) {
  const healthUrl = `${baseUrl}/api/health`;
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const failure = startupFailure({ child, healthUrl, spawnError });
    if (failure) {
      throw new Error(`${failure}\n${logTail(logPath)}`);
    }
    if (await isHealthy(healthUrl)) {
      return;
    }
    await delay(HEALTH_POLL_MS);
  }
  throw new Error(`the jar did not answer ${healthUrl} within ${HEALTH_TIMEOUT_MS / 1000} s\n${logTail(logPath)}`);
}

function requireJar() {
  const jar = resolveJar();
  if (jar === null) {
    throw new Error(
      `no flight-tracker jar found (looked at $FT_JAR and ${JAR_CANDIDATES.join(", ")} under ${REPO_ROOT}); ` +
        "build one with: cd backend && mvn -B package -DskipTests"
    );
  }
  return jar;
}

/** Spawns the jar with its output appended to `logPath`; `stop()` is idempotent and also runs on process exit. */
function spawnJar({ jar, workDir, logPath, env }) {
  const logFd = openSync(logPath, "a");
  let spawnError = null;
  const child = spawn("java", ["-Xmx512m", "-jar", jar], {
    cwd: workDir,
    env,
    stdio: ["ignore", logFd, logFd],
  });
  child.on("error", (err) => {
    spawnError = err;
  });

  let stopped = false;
  const stop = () => {
    if (stopped) {
      return;
    }
    stopped = true;
    process.off("exit", stop);
    if (!hasExited(child)) {
      child.kill("SIGTERM");
    }
    closeSync(logFd);
  };
  process.once("exit", stop);
  return { child, stop, spawnError: () => spawnError };
}

/**
 * Starts the flag-on jar against `fake` and waits for it to be healthy. Throws
 * with the jar's log tail if it never answers; throws a plain message when no
 * jar is built at all (the caller has already decided whether to skip).
 */
export async function startLoginApp({ fake } = {}) {
  if (!fake?.issuer) {
    throw new TypeError("startLoginApp({ fake }) needs the fake provider, e.g. the object startFakeOidc() returns");
  }
  const jar = requireJar();

  const workDir = mkdtempSync(join(tmpdir(), "ft-login-app-"));
  const logPath = join(workDir, "app.log");
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const { child, stop, spawnError } = spawnJar({ jar, workDir, logPath, env: appEnv({ port, workDir, fake }) });

  try {
    await waitForHealth({ baseUrl, child, logPath, spawnError });
  } catch (err) {
    stop();
    throw err;
  }
  return { baseUrl, port, logPath, stop };
}
