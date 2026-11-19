// One soak WebSocket client: parses every LiveFrame, records its age and the
// gap since the previous frame, counts close codes and reconnects with backoff.

const MAX_RECONNECTS = 20;

const bump = (counts, key) => {
  counts[key] = (counts[key] || 0) + 1;
};

/** The frame's observedAt in epoch ms, or null if it is not a usable frame. */
function observedAtMs(data) {
  let frame;
  try {
    frame = JSON.parse(typeof data === "string" ? data : data.toString());
  } catch {
    return null;
  }
  const observed = Date.parse(frame.observedAt);
  return Number.isNaN(observed) ? null : observed;
}

function recordGap(c, now) {
  if (c.lastArrivalMs === null) return;
  const gap = now - c.lastArrivalMs;
  c.gapCount++;
  c.gapSumMs += gap;
  if (gap > c.gapMaxMs) c.gapMaxMs = gap;
}

function onMessage(c, ctx, event) {
  if (ctx.stopping) return;
  const now = Date.now();
  c.frames++;
  ctx.framesTotal++;
  if (c.firstFrameAt === null) c.firstFrameAt = now;

  const observed = observedAtMs(event.data);
  if (observed === null) {
    c.malformed++;
    ctx.malformedTotal++;
    return;
  }
  if (ctx.inWarmup) {
    ctx.warmupFrames++;
  } else {
    ctx.steadyFrames++;
    ctx.latency.add(now - observed);
    recordGap(c, now);
  }
  c.lastArrivalMs = now;
  c.lastFrameAt = now;
}

function onClose(c, ctx, event, scheduleReconnect) {
  const code = event.code || 0;
  bump(c.closes, code);
  // Close codes seen while we are deliberately tearing down are harness
  // noise (a half-finished close handshake reports 1006). Only closes
  // that happen while the run is live say anything about the server.
  if (ctx.stopping) ctx.closesAtShutdown++;
  else bump(ctx.closeCodes, code);
  c.ws = null;
  if (!ctx.stopping) scheduleReconnect();
}

function newClient(id) {
  return {
    id,
    ws: null,
    frames: 0,
    malformed: 0,
    reconnects: 0,
    dead: false,
    closes: {},
    firstFrameAt: null,
    lastFrameAt: null,
    lastArrivalMs: null,
    gapCount: 0,
    gapSumMs: 0,
    gapMaxMs: 0,
  };
}

export function createClient(id, wsUrl, ctx) {
  const c = newClient(id);

  const scheduleReconnect = () => {
    if (ctx.stopping || c.dead) return;
    c.reconnects++;
    if (c.reconnects > MAX_RECONNECTS) {
      c.dead = true;
      ctx.deadClients++;
      return;
    }
    const delay = Math.min(250 * 2 ** Math.min(c.reconnects - 1, 5), 10_000);
    setTimeout(connect, delay);
  };

  const connect = () => {
    if (ctx.stopping || c.dead) return;
    let ws;
    try {
      ws = new WebSocket(wsUrl);
    } catch {
      bump(c.closes, "connect-error");
      scheduleReconnect();
      return;
    }
    c.ws = ws;
    ws.addEventListener("open", () => {
      ctx.connected++;
    });
    ws.addEventListener("message", (event) => onMessage(c, ctx, event));
    ws.addEventListener("close", (event) => onClose(c, ctx, event, scheduleReconnect));
    ws.addEventListener("error", () => bump(c.closes, "error"));
  };

  connect();
  return c;
}

/** Close one client and wait (at most 3 s) for the close handshake. */
export function closeAndWait(c) {
  return new Promise((resolve) => {
    const ws = c.ws;
    if (!ws || ws.readyState === WebSocket.CLOSED) return resolve();
    const done = () => resolve();
    ws.addEventListener("close", done, { once: true });
    try {
      ws.close(1000, "soak complete");
    } catch {
      return resolve();
    }
    setTimeout(done, 3000);
  });
}
