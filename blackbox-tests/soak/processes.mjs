// Child processes (the jar and the synthetic source): start, keep the last
// log lines for a fatal report, and stop with SIGTERM then SIGKILL.

import { spawn } from "node:child_process";
import { sleep } from "./config.mjs";

const KEPT_LINES = 80;

function lineKeeper(state) {
  return (chunk) => {
    for (const line of chunk.toString().split("\n")) {
      if (!line.trim()) continue;
      state.lastLines.push(line);
      if (state.lastLines.length > KEPT_LINES) state.lastLines.shift();
    }
  };
}

export function startProcess(name, command, args, opts = {}) {
  const child = spawn(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
    ...opts,
  });
  const state = { name, child, exitCode: null, signal: null, exited: false, lastLines: [] };
  const keep = lineKeeper(state);
  child.stdout?.on("data", keep);
  child.stderr?.on("data", keep);
  child.on("exit", (code, signal) => {
    state.exitCode = code;
    state.signal = signal;
    state.exited = true;
  });
  child.on("error", (err) => {
    state.spawnError = err.message;
    state.exited = true;
    keep(Buffer.from(`${name}: failed to start: ${err.message}`));
  });
  return state;
}

function kill(state, signal) {
  try {
    state.child.kill(signal);
  } catch {
    /* already gone */
  }
}

export async function stopProcess(state, timeoutMs) {
  if (!state || state.exited) return;
  kill(state, "SIGTERM");
  const deadline = Date.now() + timeoutMs;
  while (!state.exited && Date.now() < deadline) await sleep(200);
  if (!state.exited) {
    kill(state, "SIGKILL");
    await sleep(500);
  }
}
