// Server memory and CPU from /proc/PID/{status,stat} (Linux only; null elsewhere).

import { readFileSync } from "node:fs";
import { round } from "./config.mjs";

function readProc(pid, file) {
  try {
    return readFileSync(`/proc/${pid}/${file}`, "utf8");
  } catch {
    return null;
  }
}

/** A `/proc/PID/status` field given in kB (VmRSS, VmHWM), as MB to one decimal. */
function readStatusMb(pid, field) {
  const status = readProc(pid, "status");
  if (!status) return null;
  const m = status.match(new RegExp(`^${field}:\\s+(\\d+)\\s+kB`, "m"));
  return m ? round(Number(m[1]) / 1024, 1) : null;
}

export const readRssMb = (pid) => readStatusMb(pid, "VmRSS");
export const readVmHwmMb = (pid) => readStatusMb(pid, "VmHWM");

/** utime+stime in seconds. /proc/PID/stat fields are 1-indexed; after ")" state is field 3. */
export function readCpuSeconds(pid) {
  const stat = readProc(pid, "stat");
  if (!stat) return null;
  const close = stat.lastIndexOf(")");
  if (close < 0) return null;
  const fields = stat.slice(close + 2).split(" ");
  const ticks = Number(fields[11]) + Number(fields[12]); // utime, stime
  return Number.isFinite(ticks) ? round(ticks / 100, 2) : null; // CLK_TCK=100 on Linux
}
