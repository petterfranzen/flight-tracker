// Small fetch helpers: a timed JSON GET/POST and a readiness wait.

import { sleep } from "./config.mjs";

export async function fetchJson(url, timeoutMs = 3000, init = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, ...init });
    const text = await res.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

export const isOk = (status) => status >= 200 && status < 300;

async function probe(url) {
  try {
    const { status } = await fetchJson(url, 3000);
    return isOk(status) ? null : `HTTP ${status}`;
  } catch (e) {
    return e.name === "AbortError" ? "timeout" : e.message;
  }
}

export async function waitFor(url, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    const problem = await probe(url);
    if (problem === null) return;
    last = problem;
    await sleep(1000);
  }
  throw new Error(`${label} did not become ready within ${timeoutMs}ms (last: ${last})`);
}
